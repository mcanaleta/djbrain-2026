import type { AppSettings } from './settings-store.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { DiscogsRelease, DiscogsMaster, DiscogsEntity } from '../shared/discogs.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import { DISCOGS_CONFIDENT_THRESHOLD } from '../shared/discogs-match.ts'
import { looksLikeVersion, parseTrackTitle } from '../shared/track-title-parser.ts'
import { parseDurationString } from '../shared/track-matcher.ts'
import type { OnlineSearchItem } from '../shared/online-search.ts'

// ─── Normalisation ────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(value: string): string[] {
  return norm(value)
    .split(/\s+/)
    .filter((token) => token && token.length >= 2 && !['and', 'version'].includes(token))
}

function recall(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0
  const candidateSet = new Set(candidateTokens)
  let hits = 0
  for (const token of queryTokens) if (candidateSet.has(token)) hits += 1
  return hits / queryTokens.length
}

// Loose substring containment score (0–1)
function containsScore(haystack: string, needle: string): number {
  if (!needle) return 0
  if (haystack === needle) return 1
  if (haystack.includes(needle)) return 0.8
  if (needle.includes(haystack)) return 0.6
  return 0
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const next = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = next
    }
  }
  return dp[b.length]
}

function splitTargetTitleAndVersion(targetTitle: string, targetVersion: string | null): { title: string; version: string | null } {
  if (targetVersion) return { title: targetTitle, version: targetVersion }
  const parsed = parseTrackTitle(targetTitle)
  if (parsed.version) return parsed
  const words = targetTitle.trim().split(/\s+/).filter(Boolean)
  for (let size = Math.min(3, words.length - 1); size >= 1; size -= 1) {
    const version = words.slice(-size).join(' ')
    if (!looksLikeVersion(version)) continue
    const title = words.slice(0, -size).join(' ').trim()
    if (title) return { title, version }
  }
  return { title: targetTitle, version: null }
}

// ─── Per-track scoring ────────────────────────────────────────────────────────

function scoreTrackTitle(
  trackTitle: string,
  targetTitle: string,
  targetVersion: string | null
): number {
  const target = splitTargetTitleAndVersion(targetTitle, targetVersion)
  const parsedTrack = parseTrackTitle(trackTitle)
  const normTrack = norm((parsedTrack.title || trackTitle).replace(/\s*\[[^\]]+\]/g, '').trim())
  const normTarget = norm(target.title)

  let score = 0

  if (normTrack === normTarget) {
    score += 60
  } else {
    score += Math.round(containsScore(normTrack, normTarget) * 50)
    const distance = editDistance(normTrack, normTarget)
    if (distance <= 1) score += 44
    else if (distance === 2) score += 30
  }

  if (target.version) {
    const normVersion = norm(target.version)
    const normTrackVersion = norm(parsedTrack.version ?? '')
    if (normTrackVersion === normVersion) score += 20
    else if (normTrackVersion && (normTrackVersion.includes(normVersion) || normVersion.includes(normTrackVersion)))
      score += 12
    else if (trackTitle.toLowerCase().includes(normVersion)) score += 15
    else score += Math.round(recall(tokens(target.version), tokens(parsedTrack.version ?? '')) * 18)
  } else if (norm(parsedTrack.version ?? '')) {
    score -= 18
  }

  return score
}

// ─── Per-release scoring ──────────────────────────────────────────────────────

type TrackableEntity = DiscogsRelease | DiscogsMaster

function scoreArtist(entity: TrackableEntity, targetArtist: string): number {
  const normTarget = norm(targetArtist)
  if (!normTarget) return 0

  for (const candidate of entity.artists) {
    const normCandidate = norm(candidate)
    if (normCandidate === normTarget) return 20
    if (normCandidate.includes(normTarget) || normTarget.includes(normCandidate)) return 12
  }

  return 0
}

function extractLabel(entity: TrackableEntity): string | null {
  if (entity.type === 'release' && entity.labels.length > 0) {
    return entity.labels[0]
  }
  return null
}

function extractCatalogNumber(entity: TrackableEntity): string | null {
  if (entity.type === 'release' && entity.catalogNumbers.length > 0) {
    return entity.catalogNumbers[0]
  }
  return null
}

function resolveArtist(entity: TrackableEntity, fallback: string): string {
  if (entity.artists.length > 0) {
    return entity.artists.join(', ')
  }
  return fallback
}

function scoreRelease(entity: TrackableEntity, title: string): number {
  const releaseTitle = norm(entity.title)
  const format = entity.type === 'release' ? norm(entity.formats.join(' ')) : ''
  let score = 0
  if (releaseTitle === norm(title)) score += 8
  else if (releaseTitle.includes(norm(title))) score += 4
  if (/\b(compilation|sessions|greatest|hits|best|collection|archive|vol|volume|mixed)\b/.test(releaseTitle)) score -= 12
  if (format.includes('compilation')) score -= 12
  if (format.includes('file')) score -= 8
  if (format.includes('single')) score += 6
  if (format.includes('maxi')) score += 4
  return score
}

function isTrackable(entity: DiscogsEntity): entity is TrackableEntity {
  return entity.type === 'release' || entity.type === 'master'
}

// ─── Service ──────────────────────────────────────────────────────────────────

export type DiscogsMatchResult = {
  match: DiscogsTrackMatch | null
  candidates: DiscogsTrackMatch[]
}

export class DiscogsMatchService {
  async findTrack(
    settings: AppSettings,
    artist: string,
    title: string,
    version: string | null,
    onlineSearch: OnlineSearchService
  ): Promise<DiscogsMatchResult> {
    const query = [artist, title, version].filter(Boolean).join(' ')
    console.log('[discogs-match] searching:', JSON.stringify(query))

    let results
    try {
      results = await onlineSearch.searchDiscogsReleases(settings, query)
    } catch (err) {
      console.error('[discogs-match] search failed:', err)
      return { match: null, candidates: [] }
    }
    if (results.length === 0 && artist.trim() && artist.trim().split(/\s+/).length === 1) {
      const titleTail = title.trim().split(/\s+/).slice(1).join(' ')
      if (titleTail) {
        const fallbackQuery = [artist, titleTail, version].filter(Boolean).join(' ')
        console.log('[discogs-match] fallback search:', JSON.stringify(fallbackQuery))
        try {
          results = await onlineSearch.searchDiscogsReleases(settings, fallbackQuery)
        } catch (err) {
          console.error('[discogs-match] fallback search failed:', err)
        }
      }
    }

    console.log('[discogs-match] got', results.length, 'results')

    return this.scoreResults(results.map((result) => ({ id: result.id, type: result.type })), settings, artist, title, version, onlineSearch)
  }

  async findTrackViaWebSearch(
    settings: AppSettings,
    artist: string,
    title: string,
    version: string | null,
    onlineSearch: OnlineSearchService
  ): Promise<DiscogsMatchResult> {
    const query = [artist, title, version, 'discogs'].filter(Boolean).join(' ')
    console.log('[discogs-match] web search:', JSON.stringify(query))
    let items: OnlineSearchItem[] = []
    try {
      items = (await onlineSearch.search(settings, query, 'online')).items
    } catch (err) {
      console.error('[discogs-match] web search failed:', err)
      return { match: null, candidates: [] }
    }
    return this.scoreResults(
      items
        .filter((item) => item.source === 'discogs')
        .map((item) => ({ id: this.idFromLink(item.link), type: item.sourceType ?? 'release' })),
      settings,
      artist,
      title,
      version,
      onlineSearch
    )
  }

  private async scoreResults(
    results: Array<{ id?: number | null; type?: unknown }>,
    settings: AppSettings,
    artist: string,
    title: string,
    version: string | null,
    onlineSearch: OnlineSearchService
  ): Promise<DiscogsMatchResult> {

    const candidates: DiscogsTrackMatch[] = []

    for (const result of results.slice(0, 10)) {
      const type = this.normalizeType(result.type)
      if (type !== 'release') continue
      if (!result.id) continue

      let entity: DiscogsEntity
      try {
        entity = await onlineSearch.getDiscogsEntity(settings, type, result.id)
      } catch (err) {
        console.warn(`[discogs-match] failed to fetch ${type}/${result.id}:`, err)
        continue
      }

      if (!isTrackable(entity)) continue
      if (!entity.tracklist.length) continue

      const artistScore = scoreArtist(entity, artist)

      // Find best matching track in the tracklist
      let bestTrack: (typeof entity.tracklist)[number] | null = null
      let bestTrackScore = 0

      for (const track of entity.tracklist) {
        const ts = scoreTrackTitle(track.title, title, version)
        if (ts > bestTrackScore) {
          bestTrackScore = ts
          bestTrack = track
        }
      }

      if (!bestTrack || bestTrackScore === 0) continue

      const totalScore = artistScore + bestTrackScore + scoreRelease(entity, title)
      console.log(
        `[discogs-match] ${type}/${result.id} "${entity.title}": artistScore=${artistScore} trackScore=${bestTrackScore} total=${totalScore} track="${bestTrack.title}"`
      )

      candidates.push({
        releaseId: entity.id,
        releaseTitle: entity.title,
        format: entity.type === 'release' ? entity.formats[0] ?? null : null,
        artist: resolveArtist(entity, artist),
        title: bestTrack.title,
        version: null,
        trackPosition: bestTrack.position ?? null,
        year: entity.year ?? null,
        label: extractLabel(entity),
        catalogNumber: extractCatalogNumber(entity),
        country: entity.type === 'release' ? entity.country ?? null : null,
        durationSeconds: bestTrack.duration ? parseDurationString(bestTrack.duration) : null,
        score: totalScore
      })
    }

    candidates.sort((a, b) => b.score - a.score)

    const match =
      candidates.length > 0 && candidates[0].score >= DISCOGS_CONFIDENT_THRESHOLD
        ? candidates[0]
        : null

    return { match, candidates }
  }

  private idFromLink(link: string | null | undefined): number | null {
    const match = link?.match(/discogs\.com\/(?:[^/]+\/)?(?:release|master)\/(\d+)/i)
    return match?.[1] ? Number(match[1]) : null
  }

  private normalizeType(value: unknown): 'release' | 'master' | null {
    if (typeof value !== 'string') return null
    const v = value.toLowerCase().trim()
    if (v === 'release') return 'release'
    if (v === 'master' || v === 'master release') return 'master'
    return null
  }
}

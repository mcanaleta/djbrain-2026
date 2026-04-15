import type { AppSettings } from './settings-store.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { DiscogsRelease, DiscogsMaster, DiscogsEntity } from '../shared/discogs.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import { DISCOGS_CONFIDENT_THRESHOLD } from '../shared/discogs-match.ts'
import { parseTrackTitle } from '../shared/track-title-parser.ts'
import { parseDurationString } from '../shared/track-matcher.ts'

// ─── Normalisation ────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
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

// ─── Per-track scoring ────────────────────────────────────────────────────────

function scoreTrackTitle(
  trackTitle: string,
  targetTitle: string,
  targetVersion: string | null
): number {
  const parsedTrack = parseTrackTitle(trackTitle)
  const normTrack = norm((parsedTrack.title || trackTitle).replace(/\s*\[[^\]]+\]/g, '').trim())
  const normTarget = norm(targetTitle)

  let score = 0

  if (normTrack === normTarget) {
    score += 60
  } else {
    score += Math.round(containsScore(normTrack, normTarget) * 50)
  }

  if (targetVersion) {
    const normVersion = norm(targetVersion)
    const normTrackVersion = norm(parsedTrack.version ?? '')
    if (normTrackVersion === normVersion) score += 20
    else if (normTrackVersion && (normTrackVersion.includes(normVersion) || normVersion.includes(normTrackVersion)))
      score += 12
    else if (trackTitle.toLowerCase().includes(normVersion)) score += 15
    else score += Math.round(recall(tokens(targetVersion), tokens(parsedTrack.version ?? '')) * 18)
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

    console.log('[discogs-match] got', results.length, 'results')

    const candidates: DiscogsTrackMatch[] = []

    for (const result of results.slice(0, 5)) {
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

  private normalizeType(value: unknown): 'release' | 'master' | null {
    if (typeof value !== 'string') return null
    const v = value.toLowerCase().trim()
    if (v === 'release') return 'release'
    if (v === 'master' || v === 'master release') return 'master'
    return null
  }
}

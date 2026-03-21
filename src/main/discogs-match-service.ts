import type { AppSettings } from './settings-store.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { DiscogsEntityDetail } from '../shared/discogs.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import { DISCOGS_CONFIDENT_THRESHOLD } from '../shared/discogs-match.ts'

// ─── Normalisation ────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  const normTrack = norm(trackTitle)
  const normTarget = norm(targetTitle)

  let score = 0

  if (normTrack === normTarget) {
    score += 60
  } else {
    score += Math.round(containsScore(normTrack, normTarget) * 50)
  }

  if (targetVersion) {
    const normVersion = norm(targetVersion)
    if (normTrack.includes(normVersion)) score += 15
  }

  return score
}

// ─── Per-release scoring ──────────────────────────────────────────────────────

function scoreArtist(entity: DiscogsEntityDetail, targetArtist: string): number {
  const normTarget = norm(targetArtist)

  // subtitle is the artist string for releases/masters
  const candidates = [
    entity.subtitle ?? '',
    // also check inside relatedSections for artists
    ...(entity.relatedSections
      .find((s) => s.title === 'Artists')
      ?.items.map((i) => i.name) ?? [])
  ]

  for (const candidate of candidates) {
    const normCandidate = norm(candidate)
    if (normCandidate === normTarget) return 20
    if (normCandidate.includes(normTarget) || normTarget.includes(normCandidate)) return 12
  }

  return 0
}

function extractLabel(entity: DiscogsEntityDetail): string | null {
  return entity.facts.find((f) => f.label === 'Labels')?.value ?? null
}

function extractCatalogNumber(entity: DiscogsEntityDetail): string | null {
  return entity.facts.find((f) => f.label === 'Catalog No')?.value ?? null
}

function resolveArtist(entity: DiscogsEntityDetail, fallback: string): string {
  const artistSection = entity.relatedSections.find((s) => s.title === 'Artists')
  if (artistSection && artistSection.items.length > 0) {
    return artistSection.items.map((i) => i.name).join(', ')
  }
  return entity.subtitle ?? fallback
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
      if (type !== 'release' && type !== 'master') continue
      if (!result.id) continue

      let entity: DiscogsEntityDetail
      try {
        entity = await onlineSearch.getDiscogsEntity(settings, type, result.id)
      } catch (err) {
        console.warn(`[discogs-match] failed to fetch ${type}/${result.id}:`, err)
        continue
      }

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

      const totalScore = artistScore + bestTrackScore
      console.log(
        `[discogs-match] ${type}/${result.id} "${entity.title}": artistScore=${artistScore} trackScore=${bestTrackScore} total=${totalScore} track="${bestTrack.title}"`
      )

      candidates.push({
        releaseId: entity.id,
        releaseTitle: entity.title,
        artist: resolveArtist(entity, artist),
        title: bestTrack.title,
        version: null,
        trackPosition: bestTrack.position ?? null,
        year: entity.year ?? null,
        label: extractLabel(entity),
        catalogNumber: extractCatalogNumber(entity),
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

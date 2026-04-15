import { parseTrackTitle } from '../shared/track-title-parser.ts'

type MusicBrainzSearchResponse = {
  recordings?: Array<{
    id?: string
    title?: string
    disambiguation?: string
    score?: string | number
    length?: number
    'first-release-date'?: string
    releases?: Array<{
      title?: string
      'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] }
    }>
    'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>
  }>
}

export type MusicBrainzRecordingMatch = {
  recordingId: string
  artist: string
  title: string
  version: string | null
  year: string | null
  releaseTitle: string | null
  durationSeconds: number | null
  score: number
  rawJson: string
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeQuery(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function normalizeText(value: string | null | undefined): string {
  return normalizeQuery(value)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokenize(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token && token.length >= 2 && token !== 'vs')
}

function recall(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0
  const candidateSet = new Set(candidateTokens)
  let hits = 0
  for (const token of queryTokens) if (candidateSet.has(token)) hits += 1
  return hits / queryTokens.length
}

function localMatchScore(
  queryArtist: string,
  queryTitle: string,
  queryVersion: string | null,
  candidateArtist: string,
  candidateTitle: string,
  candidateVersion: string | null,
  releaseTitle: string | null
): number {
  const normQueryTitle = normalizeText(queryTitle)
  const normCandidateTitle = normalizeText(candidateTitle)
  const normQueryVersion = normalizeText(queryVersion)
  const normCandidateVersion = normalizeText(candidateVersion)
  const normReleaseTitle = normalizeText(releaseTitle)
  const queryArtistTokens = tokenize(queryArtist)
  const artistRecall = recall(queryArtistTokens, tokenize(candidateArtist))

  let score = 0
  if (normQueryTitle && normCandidateTitle) {
    if (normQueryTitle === normCandidateTitle) score += 60
    else if (normCandidateTitle.includes(normQueryTitle) || normQueryTitle.includes(normCandidateTitle)) score += 45
    else score += Math.round(recall(tokenize(queryTitle), tokenize(candidateTitle)) * 35)
  }

  score += Math.round(artistRecall * 30)
  if (queryArtistTokens.length > 0 && artistRecall === 0) score -= 30

  if (normQueryVersion) {
    if (normQueryVersion === normCandidateVersion) score += 20
    else if (normQueryVersion && normCandidateVersion && (normCandidateVersion.includes(normQueryVersion) || normQueryVersion.includes(normCandidateVersion))) score += 14
  } else if (!normCandidateVersion) {
    score += 5
  }

  if (normReleaseTitle) {
    if (normReleaseTitle === normQueryTitle || normReleaseTitle.includes(normQueryTitle)) score += 10
    if (/\b(vol|volume|compilation|anthology|sessions|greatest|best|mix|live|collection|archive)\b/.test(normReleaseTitle)) score -= 15
  }

  return Math.max(0, Math.min(100, score))
}

function releasePreferenceScore(
  release: { title?: string; 'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] } } | undefined
): number {
  const title = normalizeText(release?.title)
  const primaryType = normalizeText(release?.['release-group']?.['primary-type'])
  const secondaryTypes = new Set((release?.['release-group']?.['secondary-types'] ?? []).map(normalizeText))
  let score = 0
  if (primaryType === 'single') score += 10
  else if (primaryType === 'ep') score += 5
  else if (primaryType === 'album') score -= 5
  if (secondaryTypes.has('compilation')) score -= 20
  if (/\b(vol|volume|compilation|anthology|sessions|greatest|hits|best|mix|live|collection|archive)\b/.test(title)) score -= 12
  return score
}

export class MusicBrainzService {
  async searchRecordings(
    artist: string,
    title: string,
    version: string | null,
    limit: number = 5
  ): Promise<MusicBrainzRecordingMatch[]> {
    const query = [normalizeQuery(artist), normalizeQuery(title), normalizeQuery(version)].filter(Boolean).join(' ')
    if (!query) return []

    const url = new URL('https://musicbrainz.org/ws/2/recording')
    url.searchParams.set('query', query)
    url.searchParams.set('fmt', 'json')
    url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 10))))

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'djbrain/1.0 ( local music identification )'
      }
    })
    if (!response.ok) {
      throw new Error(`MusicBrainz search failed (${response.status}).`)
    }

    const payload = (await response.json()) as MusicBrainzSearchResponse
    return (payload.recordings ?? [])
      .map((recording) => {
        const recordingId = typeof recording.id === 'string' ? recording.id : ''
        if (!recordingId) return null
        const parsed = parseTrackTitle(recording.title?.trim() || '')
        const release = recording.releases?.[0]
        const artists = (recording['artist-credit'] ?? [])
          .map((credit) => credit.artist?.name ?? credit.name ?? '')
          .filter(Boolean)
          .join(', ')
        const year = recording['first-release-date']?.slice(0, 4) ?? null
        const localScore = localMatchScore(
          artist,
          title,
          version,
          artists,
          parsed.title || recording.title?.trim() || '',
          parsed.version ?? (normalizeQuery(recording.disambiguation) || null),
          release?.title?.trim() || null
        )
        const score = Math.max(0, Math.min(100, localScore + releasePreferenceScore(release)))
        if (score < 55) return null
        return {
          recordingId,
          artist: artists,
          title: parsed.title || recording.title?.trim() || '',
          version: parsed.version ?? (normalizeQuery(recording.disambiguation) || null),
          year,
          releaseTitle: release?.title?.trim() || null,
          durationSeconds:
            recording.length != null && Number.isFinite(recording.length)
              ? Math.round(recording.length / 1000)
              : null,
          score,
          rawJson: JSON.stringify(recording)
        }
      })
      .filter((item): item is MusicBrainzRecordingMatch => Boolean(item))
      .sort((left, right) => right.score - left.score)
  }
}

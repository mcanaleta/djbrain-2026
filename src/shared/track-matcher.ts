/**
 * Generic track-to-candidate matching and scoring.
 *
 * A "candidate" is anything we can match against a track: a YouTube video,
 * a local file, a Soulseek result, etc.  The caller supplies the candidate's
 * title and optional duration; this module handles normalisation and scoring.
 *
 * Score breakdown (0-100):
 *   - Title recall   0-60  (fraction of track-title tokens found in candidate)
 *   - Artist recall  0-25  (fraction of artist tokens found in candidate)
 *   - Duration match 0-15  (proximity in seconds)
 */

export type MatchCandidate = {
  /** Stable identifier — YouTube video ID, local filename, etc. */
  id: string
  /** Raw display title used for matching (e.g. video title or "Artist - Title" from filename) */
  title: string
  /** Duration in seconds, if known */
  duration?: number
  /** Optional display tag shown in the UI (e.g. "Songs", "Downloads") */
  tag?: string
}

export type ScoredCandidate = MatchCandidate & {
  score: number // 0-100
}

export type TrackMatchQuery = {
  /** Full track title as it appears on the release, e.g. "Protec (Extended Version)" */
  title: string
  /** Artist(s), comma-separated */
  artist: string
  /** Track duration in seconds, parsed from "m:ss" string */
  durationSeconds?: number
}

// ── Normalisation ────────────────────────────────────────────────────────────

/** Noise patterns common in DJ / rave YouTube uploads and filenames */
const NOISE_RE =
  /\b(vinilo|makina|remember|revival|vinyl|hardstyle|hardcore|rave|dj\s*set|full\s*album)\b/gi

/** Remove year suffixes / prefixes like "- 1997", "(1997)", "[1997]" */
const YEAR_RE = /[-–]?\s*[\[(]?(19|20)\d{2}[\])]?/g

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(YEAR_RE, ' ')
    .replace(NOISE_RE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse "m:ss" or "mm:ss" → seconds, or null if unparseable */
export function parseDurationString(s: string): number | null {
  const m = s.match(/^(\d+):(\d{2})$/)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length >= 3))
}

/** Recall: how many query tokens appear in the candidate token set? */
function recall(queryToks: Set<string>, candidateToks: Set<string>): number {
  if (queryToks.size === 0) return 0
  let hits = 0
  for (const t of queryToks) if (candidateToks.has(t)) hits++
  return hits / queryToks.size
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export function scoreCandidate(query: TrackMatchQuery, candidate: MatchCandidate): number {
  const normTitle = normalize(query.title)
  const normArtist = normalize(query.artist)
  const normCandidate = normalize(candidate.title)

  const titleToks = tokens(normTitle)
  const artistToks = tokens(normArtist)
  const candidateToks = tokens(normCandidate)

  const titleScore = Math.round(recall(titleToks, candidateToks) * 60)
  const artistScore = Math.round(recall(artistToks, candidateToks) * 25)

  let durationScore = 0
  if (query.durationSeconds != null && candidate.duration != null) {
    const diff = Math.abs(query.durationSeconds - candidate.duration)
    if (diff <= 2) durationScore = 15
    else if (diff <= 5) durationScore = 12
    else if (diff <= 10) durationScore = 8
    else if (diff <= 20) durationScore = 3
  }

  return titleScore + artistScore + durationScore
}

export function rankCandidates(
  query: TrackMatchQuery,
  candidates: MatchCandidate[]
): ScoredCandidate[] {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(query, c) }))
    .sort((a, b) => b.score - a.score)
}

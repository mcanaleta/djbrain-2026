import type { AudioAnalysis, ImportReview, ImportReviewSearch, ImportTagPreview } from '../../../shared/api'

export type TagDraft = Record<keyof ImportTagPreview, string>
export type SearchDraft = { artist: string; title: string; version: string }
export type ReviewCandidate = ImportReview['candidates'][number]

export const EMPTY_TAG_DRAFT: TagDraft = {
  artist: '',
  title: '',
  album: '',
  year: '',
  label: '',
  catalogNumber: '',
  trackPosition: '',
  discogsReleaseId: '',
  discogsTrackPosition: ''
}

const TAG_KEYS = Object.keys(EMPTY_TAG_DRAFT) as Array<keyof TagDraft>

export function formatScore(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}`
}

export function formatFormat(value: string | null | undefined): string {
  return value ? value.toUpperCase() : '—'
}

export function formatQualityTitle(score: number | null | undefined, analysis: AudioAnalysis | null | undefined): string {
  return score == null || !Number.isFinite(score)
    ? 'No audio analysis score yet'
    : `Analysis score ${Math.round(score)}/100${analysis?.bitrateKbps != null ? ` · ${Math.round(analysis.bitrateKbps)}kbps` : ''}`
}

export function toSearchDraft(search: ImportReviewSearch | null | undefined): SearchDraft {
  return {
    artist: search?.artist ?? '',
    title: search?.title ?? '',
    version: search?.version ?? ''
  }
}

export function toSearchInput(search: SearchDraft): ImportReviewSearch {
  return {
    artist: search.artist.trim(),
    title: search.title.trim(),
    version: search.version.trim() || null
  }
}

export function summarizeMediaType(value: string | null | undefined): string {
  const normalized = value?.toLowerCase() ?? ''
  if (!normalized) return '—'
  if (/\bvinyl|vinilo|12"|10"|7"|45 ?rpm|33 ?rpm\b/.test(normalized)) return 'Vinyl'
  if (/\bcd|cdm|compact disc\b/.test(normalized)) return 'CD'
  if (/\bcassette|tape\b/.test(normalized)) return 'Tape'
  if (/\bfile|digital|web|bandcamp|beatport|traxsource\b/.test(normalized)) return 'WEB'
  return value?.split(' · ')[0] ?? '—'
}

export function toTagDraft(tags: ImportTagPreview | null | undefined): TagDraft {
  return {
    artist: tags?.artist ?? '',
    title: tags?.title ?? '',
    album: tags?.album ?? '',
    year: tags?.year ?? '',
    label: tags?.label ?? '',
    catalogNumber: tags?.catalogNumber ?? '',
    trackPosition: tags?.trackPosition ?? '',
    discogsReleaseId: tags?.discogsReleaseId?.toString() ?? '',
    discogsTrackPosition: tags?.discogsTrackPosition ?? ''
  }
}

export function toTagPreview(draft: TagDraft): ImportTagPreview {
  const text = (value: string): string | null => value.trim() || null
  const number = (value: string): number | null => {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    artist: text(draft.artist),
    title: text(draft.title),
    album: text(draft.album),
    year: text(draft.year),
    label: text(draft.label),
    catalogNumber: text(draft.catalogNumber),
    trackPosition: text(draft.trackPosition),
    discogsReleaseId: number(draft.discogsReleaseId),
    discogsTrackPosition: text(draft.discogsTrackPosition)
  }
}

export function mergeTagDraft(
  current: TagDraft,
  fallback: TagDraft,
  dirty: Partial<Record<keyof TagDraft, boolean>>
): TagDraft {
  return Object.fromEntries(TAG_KEYS.map((key) => [key, dirty[key] ? current[key] : fallback[key]])) as TagDraft
}

function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
}

export function buildDestinationPreview(filename: string, candidatePath: string | null, version: string | null, tags: TagDraft): string {
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? ''
  const [songsFolder = 'songs'] = (candidatePath ?? 'songs').split('/')
  const year = sanitizeFilenameSegment(tags.year) || 'unknown'
  const artist = sanitizeFilenameSegment(tags.artist) || 'Unknown artist'
  const title = sanitizeFilenameSegment(tags.title) || 'Unknown title'
  return `${songsFolder}/${year}/${artist} - ${title}${version ? ` (${sanitizeFilenameSegment(version)})` : ''}${ext}`
}

export function guessYear(path: string): string {
  return path.match(/(?:^|\/)(19|20)\d{2}(?:\/|$)/)?.[0]?.replaceAll('/', '') ?? '—'
}

export function guessMeta(path: string): { artist: string; title: string; year: string } {
  const normalized = path.replace(/\.[^.]+$/, '').split('/').pop() ?? path
  const match = normalized.match(/^(.*?) - (.*)$/)
  return {
    artist: match?.[1]?.trim() || '—',
    title: match?.[2]?.trim() || normalized,
    year: guessYear(path)
  }
}

export function withVersion(title: string, version?: string | null): string {
  return version ? `${title} (${version})` : title
}

export function candidateKey(candidate: ReviewCandidate | null): string | null {
  return candidate ? `${candidate.match.releaseId}:${candidate.match.trackPosition ?? ''}:${candidate.match.title}` : null
}

export function pickSelectedCandidateIndex(review: ImportReview, currentKey: string | null): number | null {
  if (currentKey) {
    const index = review.candidates.findIndex((candidate) => candidateKey(candidate) === currentKey)
    if (index !== -1) return index
  }
  return review.selectedCandidateIndex
}

export function pickExistingFilename(
  review: ImportReview,
  candidate: ReviewCandidate | null,
  currentFilename: string | null
): string | null {
  const filenames = new Set(review.similarItems.map((item) => item.filename))
  if (candidate?.exactExistingFilename && filenames.has(candidate.exactExistingFilename)) return candidate.exactExistingFilename
  if (currentFilename && filenames.has(currentFilename)) return currentFilename
  return review.similarItems[0]?.filename ?? null
}

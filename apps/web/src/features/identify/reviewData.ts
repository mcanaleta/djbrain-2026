import type { CollectionItemDetails, IdentifyRecordCandidate, IdentifyReference, IdentifyReviewData, RecordingCanonical } from '@djbrain/shared/api'
import { parseTrackTitle } from '@djbrain/shared/track-title-parser'
import { withVersion } from '../../lib/importReview'
import { deriveTrackSummaryFromFilename } from '../../lib/music-file'

const text = (value: string | null | undefined): string | null => value?.trim() || null
const keyFor = (artist: string | null, title: string | null, version: string | null, fallback: string): string =>
  [artist, title, version].map((value) => text(value)?.toLowerCase()).filter(Boolean).join(':') || fallback

const parsePayload = (value: string | null | undefined): Record<string, unknown> | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const sortReferences = (references: IdentifyReference[]): IdentifyReference[] =>
  [...references].sort((left, right) => {
    if (left.assignable !== right.assignable) return left.assignable ? -1 : 1
    return (right.score ?? -1) - (left.score ?? -1)
  })

const mergeCandidates = (recordCandidates: IdentifyRecordCandidate[]): IdentifyRecordCandidate[] => {
  const merged = new Map<string, IdentifyRecordCandidate>()
  for (const candidate of recordCandidates) {
    const key = candidate.recordingId != null ? `recording:${candidate.recordingId}` : candidate.key
    const current = merged.get(key)
    if (!current) {
      merged.set(key, { ...candidate, key, references: [...candidate.references] })
      continue
    }
    const preferred = (left: IdentifyRecordCandidate, right: IdentifyRecordCandidate): IdentifyRecordCandidate =>
      (left.references[0]?.score ?? -1) >= (right.references[0]?.score ?? -1) ? left : right
    const best = preferred(current, candidate)
    current.canonical = best.canonical
    current.recordingId = current.recordingId ?? candidate.recordingId
    current.references = [...current.references, ...candidate.references]
  }
  return [...merged.values()].map((candidate) => ({
    ...candidate,
    references: sortReferences(
      candidate.references.filter((reference, index, all) => all.findIndex((other) => other.key === reference.key) === index)
    )
  }))
}

const refsFromItem = (item: CollectionItemDetails): IdentifyReference[] => {
  const references: IdentifyReference[] = (item.identification?.candidates ?? []).filter((candidate) => candidate.provider !== 'manual').map((candidate) => {
    const payload = parsePayload(candidate.payloadJson)
    return {
      key: `${candidate.provider}:${candidate.externalKey}`,
      provider: candidate.provider,
      entityType: candidate.entityType,
      externalKey: candidate.externalKey,
      artist: text((payload?.artist as string | undefined) ?? candidate.recordingCanonical?.artist),
      title: text((payload?.title as string | undefined) ?? candidate.recordingCanonical?.title),
      version: text((payload?.version as string | undefined) ?? candidate.recordingCanonical?.version),
      releaseTitle: text(payload?.releaseTitle as string | undefined),
      label: text(payload?.label as string | undefined),
      format: text(payload?.format as string | undefined),
      catalogNumber: text(payload?.catalogNumber as string | undefined),
      country: text(payload?.country as string | undefined),
      trackPosition: text(payload?.trackPosition as string | undefined),
      year: text((payload?.year as string | undefined) ?? candidate.recordingCanonical?.year),
      durationSeconds: typeof payload?.durationSeconds === 'number' ? payload.durationSeconds : null,
      link: null,
      score: candidate.score,
      candidateId: candidate.provider === 'discogs' || candidate.provider === 'musicbrainz' ? candidate.id : null,
      assignable: candidate.provider === 'discogs' || candidate.provider === 'musicbrainz'
    } satisfies IdentifyReference
  })
  if (item.identification?.tagArtist || item.identification?.tagTitle) {
    references.push({
      key: 'tags:fallback',
      provider: 'tags',
      entityType: 'file_parse',
      externalKey: 'tags:fallback',
      artist: item.identification.tagArtist,
      title: item.identification.tagTitle,
      version: item.identification.tagVersion,
      releaseTitle: item.tags?.album ?? null,
      label: null,
      format: null,
      catalogNumber: item.tags?.catalogNumber ?? null,
      country: null,
      trackPosition: item.tags?.trackPosition ?? null,
      year: item.tags?.year ?? item.identification.parsedYear,
      durationSeconds: item.parsedAudioAnalysis?.durationSeconds ?? null,
      link: null,
      score: null,
      candidateId: null,
      assignable: false
    })
  }
  if (item.identification?.parsedArtist || item.identification?.parsedTitle) {
    references.push({
      key: 'filename:fallback',
      provider: 'filename',
      entityType: 'file_parse',
      externalKey: 'filename:fallback',
      artist: item.identification.parsedArtist,
      title: item.identification.parsedTitle,
      version: item.identification.parsedVersion,
      releaseTitle: null,
      label: null,
      format: null,
      catalogNumber: null,
      country: null,
      trackPosition: null,
      year: item.identification.parsedYear,
      durationSeconds: item.parsedAudioAnalysis?.durationSeconds ?? null,
      link: null,
      score: null,
      candidateId: null,
      assignable: false
    })
  }
  return references
}

export function identifyInferredReferences(item: CollectionItemDetails | null): IdentifyReference[] {
  if (!item?.identification) return []
  const references: IdentifyReference[] = []
  if (item.tags?.artist || item.tags?.title) {
    references.push({
      key: 'tags:local',
      provider: 'tags',
      entityType: 'file_parse',
      externalKey: 'tags:local',
      artist: item.tags.artist ?? null,
      title: item.tags.title ?? null,
      version: item.tags.version ?? null,
      releaseTitle: item.tags.album ?? null,
      label: item.tags.label ?? null,
      format: null,
      catalogNumber: item.tags.catalogNumber ?? null,
      country: null,
      trackPosition: item.tags.trackPosition ?? null,
      year: item.tags.year ?? null,
      comments: item.tags.comments ?? null,
      durationSeconds: item.parsedAudioAnalysis?.durationSeconds ?? null,
      link: null,
      score: null,
      candidateId: null,
      assignable: false,
      tagSource: item.tags.source,
      discogsReleaseId: item.tags.discogsReleaseId,
      discogsTrackPosition: item.tags.discogsTrackPosition
    })
  }
  if (item.identification.parsedArtist || item.identification.parsedTitle) {
    references.push({
      key: 'filename:local',
      provider: 'filename',
      entityType: 'file_parse',
      externalKey: 'filename:local',
      artist: item.identification.parsedArtist,
      title: item.identification.parsedTitle,
      version: item.identification.parsedVersion,
      releaseTitle: null,
      label: null,
      format: null,
      catalogNumber: null,
      country: null,
      trackPosition: null,
      year: item.identification.parsedYear,
      comments: null,
      durationSeconds: item.parsedAudioAnalysis?.durationSeconds ?? null,
      link: null,
      score: null,
      candidateId: null,
      assignable: false,
      tagSource: null,
      discogsReleaseId: null,
      discogsTrackPosition: null
    })
  }
  return references
}

export function identifyReviewData(item: CollectionItemDetails | null): IdentifyReviewData | null {
  if (!item?.identification) return null
  if (item.identification.reviewData) return normalizeStoredReviewData(item.identification.reviewData)
  const groups = new Map<string, IdentifyRecordCandidate>()
  for (const reference of refsFromItem(item)) {
    if (!reference.artist && !reference.title && !reference.version) continue
    const key = keyFor(reference.artist, reference.title, reference.version, reference.externalKey)
    const current = groups.get(key) ?? {
      key,
      canonical: { artist: reference.artist, title: reference.title, version: reference.version, year: reference.year },
      recordingId: item.identification.recordingId && key === keyFor(item.recordingCanonical?.artist ?? null, item.recordingCanonical?.title ?? null, item.recordingCanonical?.version ?? null, '') ? item.identification.recordingId : null,
      references: []
    }
    current.references.push(reference)
    groups.set(key, current)
  }
  return {
    searchHint: identifySearchHint(item),
    recordCandidates: mergeCandidates(
      [...groups.values()].map((candidate) => ({
        ...candidate,
        references: sortReferences(candidate.references)
      }))
    )
  }
}

function normalizeStoredReviewData(reviewData: IdentifyReviewData): IdentifyReviewData {
  return {
    ...reviewData,
    recordCandidates: mergeCandidates(reviewData.recordCandidates)
  }
}

export function identifySearchHint(item: CollectionItemDetails | null): string {
  const stored = item?.identification?.reviewData?.searchHint?.trim()
  if (stored) return stored
  const fallback = item ? deriveTrackSummaryFromFilename(item.filename) : { artist: '', title: '' }
  const canonical = item?.identification?.recordingCanonical ?? item?.recordingCanonical
  const artist = canonical?.artist ?? item?.identification?.tagArtist ?? item?.identification?.parsedArtist ?? item?.tags?.artist ?? fallback.artist
  const title = canonical?.title ?? item?.identification?.tagTitle ?? item?.identification?.parsedTitle ?? item?.tags?.title ?? fallback.title
  const version = canonical?.version ?? item?.identification?.tagVersion ?? item?.identification?.parsedVersion ?? item?.tags?.version ?? null
  return [text(artist), text(withVersion(title ?? '', version))].filter(Boolean).join(' - ')
}

export function parseIdentifySearchHint(value: string): Partial<RecordingCanonical> {
  const trimmed = value.trim()
  if (!trimmed) return { artist: null, title: null, version: null, year: null }
  const separatorIndex = trimmed.indexOf(' - ')
  if (separatorIndex < 0) {
    const parsed = parseTrackTitle(trimmed)
    return { artist: null, title: text(parsed.title), version: text(parsed.version), year: null }
  }
  const artist = text(trimmed.slice(0, separatorIndex))
  const parsed = parseTrackTitle(trimmed.slice(separatorIndex + 3))
  return { artist, title: text(parsed.title), version: text(parsed.version), year: null }
}

import type { RecordingDetails, WantListAddInput, WantListItem } from '../../../../shared/api'
import { formatCompactDuration } from '../../lib/music-file'

export type RecordingSourceClaim = RecordingDetails['sourceClaims'][number]

const normalize = (value: string | null | undefined): string => (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export function discogsReleaseIdFromExternalKey(externalKey: string | null | undefined): number | null {
  const match = externalKey?.match(/^discogs:release:(\d+)/i)
  return match ? Number(match[1]) : null
}

function preferredWantListClaim(recording: RecordingDetails): RecordingSourceClaim | null {
  return recording.sourceClaims.find((claim) => discogsReleaseIdFromExternalKey(claim.externalKey) != null) ?? recording.sourceClaims[0] ?? null
}

export function buildRecordingWantListInput(recording: RecordingDetails, claim: RecordingSourceClaim | null = preferredWantListClaim(recording)): WantListAddInput {
  const seconds = claim?.durationSeconds ?? recording.durationSeconds
  return {
    recordingId: recording.id,
    artist: claim?.artist ?? recording.canonical.artist ?? '',
    title: claim?.title ?? recording.canonical.title ?? '',
    version: claim?.version ?? recording.canonical.version ?? null,
    length: seconds && Number.isFinite(seconds) ? formatCompactDuration(seconds) : null,
    year: claim?.year ?? recording.canonical.year ?? null,
    album: claim?.releaseTitle ?? null,
    discogsReleaseId: discogsReleaseIdFromExternalKey(claim?.externalKey),
    discogsTrackPosition: claim?.trackPosition ?? null,
    discogsEntityType: claim?.provider === 'discogs' ? claim.entityType : null
  }
}

export function findMatchingWantListItem(items: WantListItem[], input: WantListAddInput): WantListItem | null {
  return (
    items.find((item) => input.recordingId != null && item.recordingId === input.recordingId) ??
    items.find(
      (item) =>
        input.discogsReleaseId != null &&
        item.discogsReleaseId === input.discogsReleaseId &&
        normalize(item.discogsTrackPosition) === normalize(input.discogsTrackPosition)
    ) ??
    items.find(
      (item) =>
        normalize(item.artist) === normalize(input.artist) &&
        normalize(item.title) === normalize(input.title) &&
        normalize(item.version) === normalize(input.version)
    ) ??
    null
  )
}

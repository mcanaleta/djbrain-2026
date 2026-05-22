import { relative } from 'node:path'
import type { ImportService } from '../backend/import-service.ts'
import { buildCanonicalNormKey, buildDiscogsExternalKey } from '../backend/recording-identity-service.ts'
import type { AppSettings } from '../backend/settings-store.ts'
import type {
  IdentifyReviewData,
  RecordingCanonical,
  SlskdCandidate,
  UpgradeCandidate,
  UpgradeCase,
  UpgradeCaseStatus
} from '../shared/api.ts'
import { parseDurationString } from '../shared/track-matcher.ts'

export function toMusicRelativePath(settings: AppSettings, absolutePath: string): string {
  return relative(settings.musicFolderPath, absolutePath).replace(/\\/g, '/')
}

export function cleanupDiscogsArtist(value: string): string {
  return value.replace(/\s+\(\d+\)$/g, '').trim()
}

export function buildReleaseDownloadQueries(canonical: RecordingCanonical): string[] {
  return [
    [canonical.artist, canonical.title, canonical.version].filter(Boolean).join(' '),
    [canonical.title, canonical.version].filter(Boolean).join(' '),
    canonical.title ?? ''
  ].filter((value, index, values) => value && values.indexOf(value) === index)
}

export function buildReleaseTrackReviewData(
  releaseId: number,
  releaseTitle: string,
  externalUrl: string,
  canonical: RecordingCanonical,
  track: { position?: string; duration?: string },
  recordingId: number | null
): IdentifyReviewData {
  const externalKey = buildDiscogsExternalKey(releaseId, track.position ?? null, canonical.title)
  const searchHint = canonical.version ? `${canonical.artist ?? ''} - ${canonical.title ?? ''} (${canonical.version})` : [canonical.artist, canonical.title].filter(Boolean).join(' - ')
  return {
    searchHint,
    recordCandidates: [
      {
        key: buildCanonicalNormKey(canonical),
        canonical,
        recordingId,
        references: [
          {
            key: externalKey,
            provider: 'discogs',
            entityType: 'release_track',
            externalKey,
            artist: canonical.artist,
            title: canonical.title,
            version: canonical.version,
            releaseTitle,
            label: null,
            format: null,
            catalogNumber: null,
            country: null,
            trackPosition: track.position ?? null,
            year: canonical.year,
            durationSeconds: parseDurationString(track.duration ?? ''),
            link: externalUrl,
            score: 100,
            candidateId: null,
            assignable: true
          }
        ]
      }
    ]
  }
}

export async function waitForResolvedLocalPath(settings: AppSettings, importService: ImportService, filename: string, timeoutMs: number = 180_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const localPath = await importService.resolveLocalPath(settings, filename)
    if (localPath) return localPath
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  return null
}

export function buildUpgradeCandidate(candidate: SlskdCandidate, referenceDurationSeconds: number | null): UpgradeCandidate {
  const durationSeconds = candidate.durationSeconds ?? null
  const durationDeltaSeconds =
    durationSeconds != null && referenceDurationSeconds != null
      ? durationSeconds - referenceDurationSeconds
      : null
  const durationDeltaPercent =
    durationDeltaSeconds != null && referenceDurationSeconds && referenceDurationSeconds > 0
      ? (durationDeltaSeconds / referenceDurationSeconds) * 100
      : null
  return {
    ...candidate,
    durationSeconds,
    durationDeltaSeconds,
    durationDeltaPercent,
    speedClass: durationDeltaPercent == null ? 'unknown' : Math.abs(durationDeltaPercent) <= 15 ? 'same_track_likely' : 'different_edit_likely'
  }
}

export function compareUpgradeCandidates(left: UpgradeCandidate, right: UpgradeCandidate): number {
  const leftBand = left.speedClass === 'same_track_likely' ? 0 : left.speedClass === 'unknown' ? 1 : 2
  const rightBand = right.speedClass === 'same_track_likely' ? 0 : right.speedClass === 'unknown' ? 1 : 2
  if (leftBand !== rightBand) return leftBand - rightBand
  const leftSign = left.durationDeltaPercent == null ? 2 : left.durationDeltaPercent >= 0 ? 0 : 1
  const rightSign = right.durationDeltaPercent == null ? 2 : right.durationDeltaPercent >= 0 ? 0 : 1
  if (leftSign !== rightSign) return leftSign - rightSign
  const leftDelta = left.durationDeltaPercent == null ? Number.POSITIVE_INFINITY : Math.abs(left.durationDeltaPercent)
  const rightDelta = right.durationDeltaPercent == null ? Number.POSITIVE_INFINITY : Math.abs(right.durationDeltaPercent)
  if (leftDelta !== rightDelta) return leftDelta - rightDelta
  const leftQuality = scoreUpgradeCandidateQuality(left)
  const rightQuality = scoreUpgradeCandidateQuality(right)
  if (leftQuality !== rightQuality) return rightQuality - leftQuality
  if (left.isLocked !== right.isLocked) return left.isLocked ? 1 : -1
  if ((left.queueLength ?? 9999) !== (right.queueLength ?? 9999)) return (left.queueLength ?? 9999) - (right.queueLength ?? 9999)
  if ((right.durationSeconds ?? 0) !== (left.durationSeconds ?? 0)) return (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0)
  return right.score - left.score
}

function scoreUpgradeCandidateQuality(candidate: UpgradeCandidate): number {
  const normalized = candidate.extension.trim().toLowerCase()
  const formatScore =
    normalized === 'wav' || normalized === 'aiff' || normalized === 'aif'
      ? 5
      : normalized === 'flac' || normalized === 'alac'
        ? 4
        : normalized === 'm4a' || normalized === 'aac'
          ? 3
          : normalized === 'ogg' || normalized === 'opus'
            ? 2
            : normalized === 'mp3'
              ? 1
              : 0
  return formatScore * 1000 + (candidate.bitrate ?? 0)
}

export function hasAcceptableUpgradeDuration(durationSeconds: number | null, referenceDurationSeconds: number | null): boolean {
  if (durationSeconds == null || referenceDurationSeconds == null || referenceDurationSeconds <= 0) return true
  return Math.abs((durationSeconds - referenceDurationSeconds) / referenceDurationSeconds) * 100 <= 15
}

export function getDownloadFailureStatus(upgradeCase: UpgradeCase | null | undefined): UpgradeCaseStatus {
  if (upgradeCase?.localCandidateCount) return 'downloaded'
  if (upgradeCase?.candidateCount) return 'results_ready'
  return 'error'
}

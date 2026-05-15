import type { UpgradeCaseStatus, UpgradeLocalCandidate } from '../shared/api.ts'
import { basenameOfFilename, getDownloadFolderPrefixes, normalizeFilename } from './collection-service-helpers.ts'

export type WantedDownloadCandidate = {
  username: string
  filename: string
  size: number
  score: number
  bitrate: number | null
  durationSeconds: number | null
  queueLength: number | null
  hasFreeUploadSlot: boolean | null
  uploadSpeed: number | null
  isLocked: boolean
  extension: string
}

export type DownloadAttemptStatus =
  | 'queued'
  | 'requested'
  | 'downloading'
  | 'downloaded'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'missing_local'

export type DownloadAttemptSeed = {
  status: DownloadAttemptStatus
  username: string | null
  remoteFilename: string | null
  remoteSize: number | null
}

export type DownloadRequestPlan = {
  wantListId: number
  query: string
  searchId: string
  username: string
  remoteFilename: string
  remoteSize: number
  bitrate: number | null
  durationSeconds: number | null
  extension: string
  score: number
  queueLength: number | null
  hasFreeUploadSlot: boolean | null
  uploadSpeed: number | null
  isLocked: boolean
  expectedLocalFilename: string | null
  rawCandidateJson: string
}

type BuildDownloadRequestsInput = {
  wantListId: number
  query: string
  searchId: string
  targetDownloadCount: number
  downloadFolderPaths?: string[]
  candidates: WantedDownloadCandidate[]
  existingAttempts: DownloadAttemptSeed[]
}

const ACTIVE_ATTEMPT_STATUSES = new Set<DownloadAttemptStatus>(['queued', 'requested', 'downloading', 'downloaded'])

function remoteKey(username: string | null, filename: string | null, size: number | null): string {
  return `${username ?? ''}\n${filename ?? ''}\n${size ?? 0}`
}

export function buildExpectedDownloadFilename(downloadFolderPaths: string[], remoteFilename: string | null): string | null {
  const prefix = getDownloadFolderPrefixes(downloadFolderPaths)[0]
  const normalized = remoteFilename ? normalizeFilename(remoteFilename).replace(/^\/+/, '') : ''
  if (!prefix || !normalized) return null
  const segments = normalized.split('/').filter(Boolean)
  const completeIndex = segments.map((segment) => segment.toLowerCase()).lastIndexOf('complete')
  const unsafeRoot = segments[0]?.includes(':') || segments[0]?.startsWith('@@')
  const tail = completeIndex >= 0 ? segments.slice(completeIndex + 1) : unsafeRoot ? [basenameOfFilename(normalized)] : segments
  return normalizeFilename(`${prefix}/${tail.join('/') || basenameOfFilename(normalized)}`)
}

export function downloadAttemptStatusFromSlskdState(state: string | null): DownloadAttemptStatus | null {
  if (!state) return null
  const value = state.toLowerCase()
  if (value.includes('rejected') || value.includes('errored')) return 'failed'
  if (value.includes('cancelled')) return 'cancelled'
  if (value.includes('timedout') || value.includes('timed out')) return 'timeout'
  if (value.includes('completed')) return 'downloaded'
  return 'downloading'
}

export function wantListStatusAfterAttempt(
  status: DownloadAttemptStatus,
  hasDownloadedAttempt: boolean,
  errorMessage: string | null
) {
  if (status === 'downloaded' || hasDownloadedAttempt) return { pipelineStatus: 'downloaded' as const, pipelineError: null }
  return errorMessage ? { pipelineStatus: 'error' as const, pipelineError: errorMessage } : null
}

export function buildDownloadRequests(input: BuildDownloadRequestsInput): DownloadRequestPlan[] {
  const attempted = new Set(input.existingAttempts.map((item) => remoteKey(item.username, item.remoteFilename, item.remoteSize)))
  const activeCount = input.existingAttempts.filter((item) => ACTIVE_ATTEMPT_STATUSES.has(item.status)).length
  const slots = Math.max(0, Math.trunc(input.targetDownloadCount || 3) - activeCount)
  const unlocked = input.candidates.filter((candidate) => !candidate.isLocked)
  return (unlocked.length ? unlocked : input.candidates)
    .filter((candidate) => !attempted.has(remoteKey(candidate.username, candidate.filename, candidate.size)))
    .sort((left, right) => right.score - left.score)
    .slice(0, slots)
    .map((candidate) => ({
      wantListId: input.wantListId,
      query: input.query,
      searchId: input.searchId,
      username: candidate.username,
      remoteFilename: candidate.filename,
      remoteSize: candidate.size,
      bitrate: candidate.bitrate,
      durationSeconds: candidate.durationSeconds,
      extension: candidate.extension,
      score: candidate.score,
      queueLength: candidate.queueLength,
      hasFreeUploadSlot: candidate.hasFreeUploadSlot,
      uploadSpeed: candidate.uploadSpeed,
      isLocked: candidate.isLocked,
      expectedLocalFilename: buildExpectedDownloadFilename(input.downloadFolderPaths ?? [], candidate.filename),
      rawCandidateJson: JSON.stringify(candidate)
    }))
}

export type UpgradeWantedMigrationInput = {
  id: number
  recordingId?: number | null
  collectionFilename: string
  status: UpgradeCaseStatus
  searchArtist: string
  searchTitle: string
  searchVersion: string | null
  localCandidates: UpgradeLocalCandidate[]
}

export function buildUpgradeWantedMigration(input: UpgradeWantedMigrationInput) {
  const want = {
    recordingId: input.recordingId ?? null,
    artist: input.searchArtist,
    title: input.searchTitle,
    version: input.searchVersion,
    wantKind: 'replacement' as const,
    sourceCollectionFilename: input.collectionFilename,
    pipelineStatus: input.status === 'completed' || input.status === 'pending_reanalyze' ? 'downloaded' : input.status
  }
  const attempts = input.localCandidates.map((candidate) => ({
    status: 'downloaded' as const,
    originRecordingId: input.recordingId ?? null,
    originArtist: input.searchArtist,
    originTitle: input.searchTitle,
    originVersion: input.searchVersion,
    originSourceCollectionFilename: input.collectionFilename,
    username: candidate.sourceUsername,
    remoteFilename: candidate.sourceFilename,
    localFilename: candidate.filename,
    localFilesize: candidate.filesize,
    durationSeconds: candidate.durationSeconds,
    rawCandidateJson: JSON.stringify(candidate)
  }))
  return { want, attempts }
}

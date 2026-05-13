import type { UpgradeCaseStatus, UpgradeLocalCandidate } from '../shared/api.ts'

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
  rawCandidateJson: string
}

type BuildDownloadRequestsInput = {
  wantListId: number
  query: string
  searchId: string
  targetDownloadCount: number
  candidates: WantedDownloadCandidate[]
  existingAttempts: DownloadAttemptSeed[]
}

const ACTIVE_ATTEMPT_STATUSES = new Set<DownloadAttemptStatus>(['queued', 'requested', 'downloading', 'downloaded'])

function remoteKey(username: string | null, filename: string | null, size: number | null): string {
  return `${username ?? ''}\n${filename ?? ''}\n${size ?? 0}`
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
      rawCandidateJson: JSON.stringify(candidate)
    }))
}

export type UpgradeWantedMigrationInput = {
  id: number
  collectionFilename: string
  status: UpgradeCaseStatus
  searchArtist: string
  searchTitle: string
  searchVersion: string | null
  localCandidates: UpgradeLocalCandidate[]
}

export function buildUpgradeWantedMigration(input: UpgradeWantedMigrationInput) {
  const want = {
    artist: input.searchArtist,
    title: input.searchTitle,
    version: input.searchVersion,
    wantKind: 'replacement' as const,
    sourceCollectionFilename: input.collectionFilename,
    pipelineStatus: input.status === 'completed' || input.status === 'pending_reanalyze' ? 'downloaded' : input.status
  }
  const attempts = input.localCandidates.map((candidate) => ({
    status: 'downloaded' as const,
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

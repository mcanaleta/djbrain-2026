import { execFile } from 'node:child_process'
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { CollectionService, WantListItem } from '../backend/collection-service.ts'
import type { DiscogsMatchService } from '../backend/discogs-match-service.ts'
import { FileAnalysisService } from '../backend/file-analysis-service.ts'
import { ImportProcessingQueue } from '../backend/import-processing-queue.ts'
import { ImportReviewService } from '../backend/import-review-service.ts'
import { ImportService, parseSongFilename } from '../backend/import-service.ts'
import type { OnlineSearchService } from '../backend/online-search-service.ts'
import type { AppSettings } from '../backend/settings-store.ts'
import { SlskdService } from '../backend/slskd-service.ts'
import { normalizeFilename } from '../backend/collection-service-helpers.ts'
import {
  AUDIO_ANALYSIS_VERSION,
  AUDIO_HASH_VERSION,
  IMPORT_REVIEW_VERSION
} from '../shared/analysis-version.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
import type {
  SlskdCandidate,
  UpgradeCandidate,
  UpgradeCase,
  UpgradeCaseStatus,
  UpgradeLocalCandidate,
  UpgradeReferenceSource
} from '../shared/api.ts'
import { HttpError } from './http.ts'

const execFileAsync = promisify(execFile)

type CommonDeps = {
  currentSettings: () => AppSettings
  requireCollectionService: () => CollectionService
  resolveMusicRelativePath: (filename: string) => string
}

type CollectionActionDeps = CommonDeps & {
  fileAnalysisService: FileAnalysisService
  importReviewService: ImportReviewService
  importProcessingQueue: ImportProcessingQueue
}

type WantListPipelineDeps = CommonDeps & {
  normalizeSearchText: (value: string | null | undefined) => string
  slskdService: SlskdService
  importService: ImportService
}

type UpgradePipelineDeps = CommonDeps & {
  fileAnalysisService: FileAnalysisService
  getAudioDuration: (filePath: string) => Promise<number | null>
  normalizeSearchText: (value: string | null | undefined) => string
  slskdService: SlskdService
  importService: ImportService
  discogsMatchService: DiscogsMatchService
  onlineSearchService: OnlineSearchService
}

const UPGRADE_DURATION_TOLERANCE_PERCENT = 15

export function createCollectionActions(deps: CollectionActionDeps) {
  const {
    currentSettings,
    requireCollectionService,
    resolveMusicRelativePath,
    fileAnalysisService,
    importReviewService,
    importProcessingQueue
  } = deps

  return {
    async buildImportReview(filename: string, searchValue?: unknown, force: boolean = false) {
      const absolutePath = resolveMusicRelativePath(filename)
      const parsed = parseSongFilename(basename(absolutePath))
      if (!parsed) {
        throw new HttpError(400, `Cannot parse filename: ${basename(absolutePath)}`)
      }

      const sourceAnalysis = await fileAnalysisService.get(filename, absolutePath)
      if (!searchValue && !force) {
        const cached = await requireCollectionService().readImportReviewCache(filename)
        if (cached) {
          return { ...(JSON.parse(cached) as object), sourceAnalysis }
        }
      }

      const review = await importReviewService.build({
        filename,
        absolutePath,
        parsed,
        searchValue,
        settings: currentSettings(),
        sourceAnalysis
      })

      if (!searchValue) {
        const fileStats = await stat(absolutePath)
        const preprocessed = parseImportFilename(filename)
        await requireCollectionService().saveImportReviewCache(filename, {
          filesize: fileStats.size,
          mtimeMs: Math.trunc(fileStats.mtimeMs),
          parsedArtist: review.parsed?.artist ?? null,
          parsedTitle: review.parsed?.title ?? null,
          parsedVersion: review.parsed?.version ?? null,
          parsedYear: preprocessed?.year ?? null,
          reviewJson: JSON.stringify({ ...review, sourceAnalysis: null })
        })
      }

      return review
    },

    async readCollectionStatus() {
      const status = requireCollectionService().getStatus()
      const queue = await importProcessingQueue.getStats()
      return {
        ...status,
        queueBackend: queue.backend,
        queueDepth: queue.depth,
        audioHashVersion: AUDIO_HASH_VERSION,
        audioAnalysisVersion: AUDIO_ANALYSIS_VERSION,
        importReviewVersion: IMPORT_REVIEW_VERSION
      }
    },

    async showInFolder(filePath: string): Promise<void> {
      if (process.platform === 'darwin') {
        await execFileAsync('open', ['-R', filePath])
        return
      }
      if (process.platform === 'win32') {
        await execFileAsync('explorer.exe', ['/select,', filePath])
        return
      }
      await execFileAsync('xdg-open', [dirname(filePath)])
    },

    async openInSystemPlayer(filePath: string): Promise<void> {
      if (process.platform === 'darwin') {
        await execFileAsync('open', [filePath])
        return
      }
      if (process.platform === 'win32') {
        await execFileAsync('cmd', ['/c', 'start', '', filePath])
        return
      }
      await execFileAsync('xdg-open', [filePath])
    }
  }
}

export function createWantListPipelines(deps: WantListPipelineDeps) {
  const {
    currentSettings,
    requireCollectionService,
    normalizeSearchText,
    slskdService,
    importService
  } = deps

  async function runSearchPipeline(item: WantListItem, queryOverride?: string): Promise<void> {
    const service = requireCollectionService()
    const settings = currentSettings()
    if (!settings.slskdBaseURL || !settings.slskdApiKey) {
      await service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'error',
        pipelineError: 'slskd is not configured.'
      })
      return
    }

    const artist = item.artist.trim()
    const title = item.title.trim()
    const version = item.version?.trim() || null
    if (!artist || !title) {
      await service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'error',
        pipelineError: 'Want list item is missing artist or title.'
      })
      return
    }

    try {
      const query =
        normalizeSearchText(queryOverride) || slskdService.buildSearchQuery(artist, title, version)
      const searchId = await slskdService.startSearch(settings, query)
      await service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'searching',
        searchId,
        pipelineError: null
      })

      const search = await slskdService.waitForResults(settings, searchId)
      const candidates = slskdService.extractCandidates(artist, title, version, search)
      await service.wantListUpdatePipeline(item.id, {
        pipelineStatus: candidates.length > 0 ? 'results_ready' : 'no_results',
        searchResultCount: candidates.length,
        bestCandidatesJson: candidates.length > 0 ? JSON.stringify(candidates) : null
      })
    } catch (error) {
      await service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'error',
        pipelineError: error instanceof Error ? error.message : 'Search failed'
      })
    }
  }

  async function runImportPipeline(itemId: number, localFilePath: string): Promise<void> {
    const service = requireCollectionService()
    const settings = currentSettings()
    const item = await service.wantListGet(itemId)
    if (!item) {
      return
    }

    if (!item.artist || !item.title || !item.year) {
      await service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'import_error',
        pipelineError:
          'Artist, title, and year are required before importing. Fill them in and save.'
      })
      return
    }

    await service.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'identifying',
      pipelineError: null
    })

    try {
      const match = {
        releaseId: item.discogsReleaseId ?? 0,
        releaseTitle: item.album ?? item.title,
        format: null,
        artist: item.artist,
        title: item.title,
        version: item.version,
        trackPosition: item.discogsTrackPosition,
        year: item.year,
        label: item.label,
        catalogNumber: null,
        score: 100
      }

      const result = await importService.importFileWithKnownMatch(settings, match, localFilePath)

      if (result.status === 'imported' || result.status === 'imported_upgrade') {
        await service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'imported',
          discogsReleaseId: result.match.releaseId,
          discogsTrackPosition: result.match.trackPosition,
          importedFilename: result.destRelativePath
        })
      } else if (result.status === 'skipped_existing') {
        await service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'imported',
          discogsReleaseId: result.match.releaseId,
          discogsTrackPosition: result.match.trackPosition,
          importedFilename: result.existingRelativePath
        })
      } else {
        await service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'import_error',
          pipelineError: result.status === 'error' ? result.message : 'Import failed'
        })
      }
    } catch (error) {
      await service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'import_error',
        pipelineError: error instanceof Error ? error.message : 'Import failed'
      })
    } finally {
      void service.syncNow()
    }
  }

  async function continueDownloadPipeline(
    itemId: number,
    username: string,
    filename: string
  ): Promise<void> {
    const service = requireCollectionService()
    const settings = currentSettings()

    try {
      const result = await slskdService.waitForDownload(settings, username, filename)

      if (result !== 'Completed') {
        console.warn(
          `[slskd] download did not complete: user=${username} file=${filename} result=${result}`
        )
        await service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'error',
          pipelineError:
            result === 'Timeout' ? 'Download timed out' : 'Download failed or was cancelled'
        })
        return
      }

      await service.wantListUpdatePipeline(itemId, { pipelineStatus: 'downloaded' })

      const localPath = await importService.resolveLocalPath(settings, filename)
      if (localPath) {
        void runImportPipeline(itemId, localPath)
      }
    } catch (error) {
      console.error(`[slskd] download pipeline failed: user=${username} file=${filename}`, error)
      await service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'error',
        pipelineError: error instanceof Error ? error.message : 'Download failed'
      })
    }
  }

  return {
    runSearchPipeline,
    runImportPipeline,

    async startDownloadPipeline(
      itemId: number,
      username: string,
      filename: string,
      size: number
    ): Promise<WantListItem | null> {
      const service = requireCollectionService()
      const settings = currentSettings()
      const existing = await service.wantListGet(itemId)
      if (!existing) {
        return null
      }

      await slskdService.downloadFile(settings, username, filename, size)
      const updated = await service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'downloading',
        downloadUsername: username,
        downloadFilename: filename,
        pipelineError: null
      })

      void continueDownloadPipeline(itemId, username, filename)
      return updated
    }
  }
}

function findAvailableArchivePath(basePath: string): Promise<string> {
  const ext = extname(basePath)
  const stem = ext ? basePath.slice(0, -ext.length) : basePath

  return (async () => {
    for (let index = 0; ; index += 1) {
      const candidate = index === 0 ? basePath : `${stem} (${index + 1})${ext}`
      try {
        await stat(candidate)
      } catch {
        return candidate
      }
    }
  })()
}

function toMusicRelativePath(settings: AppSettings, absolutePath: string): string {
  return normalizeFilename(relative(settings.musicFolderPath, absolutePath))
}

function buildReplacementRelativePath(collectionFilename: string, downloadFilename: string): string {
  const normalizedCollection = normalizeFilename(collectionFilename)
  const normalizedDownload = normalizeFilename(downloadFilename)
  const targetDir = dirname(normalizedCollection)
  const currentBasename = basename(normalizedCollection).replace(/\.[^.]+$/, '')
  const nextExt = extname(normalizedDownload) || extname(normalizedCollection)
  return normalizeFilename(join(targetDir, `${currentBasename}${nextExt}`))
}

async function resolveUpgradeReference(
  settings: AppSettings,
  discogsMatchService: DiscogsMatchService,
  onlineSearchService: OnlineSearchService,
  searchArtist: string,
  searchTitle: string,
  searchVersion: string | null,
  currentDurationSeconds: number | null
): Promise<{
  officialDurationSeconds: number | null
  officialDurationSource: UpgradeReferenceSource | null
  referenceDurationSeconds: number | null
  referenceDurationSource: UpgradeReferenceSource | null
}> {
  try {
    const { match, candidates } = await discogsMatchService.findTrack(
      settings,
      searchArtist,
      searchTitle,
      searchVersion,
      onlineSearchService
    )
    const officialDurationSeconds =
      match?.durationSeconds ?? candidates.find((candidate) => candidate.durationSeconds != null)?.durationSeconds ?? null
    if (officialDurationSeconds != null) {
      return {
        officialDurationSeconds,
        officialDurationSource: 'discogs',
        referenceDurationSeconds: officialDurationSeconds,
        referenceDurationSource: 'discogs'
      }
    }
  } catch (error) {
    console.warn('[upgrade] failed to resolve Discogs duration:', error)
  }

  return {
    officialDurationSeconds: null,
    officialDurationSource: null,
    referenceDurationSeconds: currentDurationSeconds,
    referenceDurationSource: currentDurationSeconds != null ? 'current_file' : null
  }
}

function buildUpgradeCandidate(
  candidate: SlskdCandidate,
  referenceDurationSeconds: number | null
): UpgradeCandidate {
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
    speedClass:
      durationDeltaPercent == null
        ? 'unknown'
        : Math.abs(durationDeltaPercent) <= UPGRADE_DURATION_TOLERANCE_PERCENT
          ? 'same_track_likely'
          : 'different_edit_likely'
  }
}

function compareUpgradeCandidates(left: UpgradeCandidate, right: UpgradeCandidate): number {
  const leftBand = left.speedClass === 'same_track_likely' ? 0 : left.speedClass === 'unknown' ? 1 : 2
  const rightBand = right.speedClass === 'same_track_likely' ? 0 : right.speedClass === 'unknown' ? 1 : 2
  if (leftBand !== rightBand) {
    return leftBand - rightBand
  }

  const leftSign = left.durationDeltaPercent == null ? 2 : left.durationDeltaPercent >= 0 ? 0 : 1
  const rightSign = right.durationDeltaPercent == null ? 2 : right.durationDeltaPercent >= 0 ? 0 : 1
  if (leftSign !== rightSign) {
    return leftSign - rightSign
  }

  const leftDelta = left.durationDeltaPercent == null ? Number.POSITIVE_INFINITY : Math.abs(left.durationDeltaPercent)
  const rightDelta = right.durationDeltaPercent == null ? Number.POSITIVE_INFINITY : Math.abs(right.durationDeltaPercent)
  if (leftDelta !== rightDelta) {
    return leftDelta - rightDelta
  }

  const leftQuality = scoreUpgradeCandidateQuality(left)
  const rightQuality = scoreUpgradeCandidateQuality(right)
  if (leftQuality !== rightQuality) {
    return rightQuality - leftQuality
  }

  if (left.isLocked !== right.isLocked) {
    return left.isLocked ? 1 : -1
  }

  if ((left.queueLength ?? 9999) !== (right.queueLength ?? 9999)) {
    return (left.queueLength ?? 9999) - (right.queueLength ?? 9999)
  }

  if ((right.durationSeconds ?? 0) !== (left.durationSeconds ?? 0)) {
    return (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0)
  }

  return right.score - left.score
}

function pickUpgradeAutoDownloads(candidates: UpgradeCandidate[]): UpgradeCandidate[] {
  const unlocked = candidates.filter((candidate) => !candidate.isLocked)
  return [...(unlocked.length > 0 ? unlocked : candidates)].sort(compareUpgradeDownloadCandidates).slice(0, 4)
}

function findSelectedCandidate(
  candidates: UpgradeCandidate[],
  localCandidate: UpgradeLocalCandidate
): UpgradeCandidate | null {
  if (localCandidate.source !== 'auto_download') {
    return null
  }
  return (
    candidates.find(
      (candidate) =>
        candidate.username === localCandidate.sourceUsername &&
        candidate.filename === localCandidate.sourceFilename
    ) ?? null
  )
}

function getDownloadFailureStatus(upgradeCase: UpgradeCase | null | undefined): UpgradeCaseStatus {
  if (upgradeCase?.localCandidateCount) return 'downloaded'
  if (upgradeCase?.candidateCount) return 'results_ready'
  return 'error'
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

function getUpgradeQueueRank(candidate: UpgradeCandidate): number {
  const queueLength = candidate.queueLength ?? 9999
  if (candidate.hasFreeUploadSlot && queueLength <= 1) return 0
  if (queueLength === 0) return 1
  if (queueLength <= 10) return 2
  if (queueLength <= 50) return 3
  if (queueLength <= 200) return 4
  return 5
}

function compareUpgradeDownloadCandidates(left: UpgradeCandidate, right: UpgradeCandidate): number {
  const leftQueue = getUpgradeQueueRank(left)
  const rightQueue = getUpgradeQueueRank(right)
  if (leftQueue !== rightQueue) {
    return leftQueue - rightQueue
  }
  return compareUpgradeCandidates(left, right)
}

export function createUpgradeActions(deps: UpgradePipelineDeps) {
  const {
    currentSettings,
    requireCollectionService,
    resolveMusicRelativePath,
    fileAnalysisService,
    getAudioDuration,
    normalizeSearchText,
    slskdService,
    importService,
    discogsMatchService,
    onlineSearchService
  } = deps
  const localCandidateWrites = new Map<number, Promise<unknown>>()

  async function withLocalCandidateWriteLock<T>(id: number, work: () => Promise<T>): Promise<T> {
    const previous = localCandidateWrites.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    localCandidateWrites.set(id, next)
    try {
      return await next
    } finally {
      if (localCandidateWrites.get(id) === next) {
        localCandidateWrites.delete(id)
      }
    }
  }

  async function buildLocalCandidate(
    filename: string,
    source: UpgradeLocalCandidate['source'],
    sourceUsername: string | null,
    sourceFilename: string | null
  ): Promise<UpgradeLocalCandidate> {
    const absolutePath = resolveMusicRelativePath(filename)
    const fileStats = await stat(absolutePath)
    return {
      filename: normalizeFilename(filename),
      filesize: fileStats.size,
      durationSeconds: await getAudioDuration(absolutePath),
      source,
      sourceUsername,
      sourceFilename
    }
  }

  async function warmUpgradeAnalysis(collectionFilename: string, localFilename: string): Promise<void> {
    const collectionPath = resolveMusicRelativePath(collectionFilename)
    const localPath = resolveMusicRelativePath(localFilename)
    await Promise.allSettled([
      fileAnalysisService.get(collectionFilename, collectionPath),
      fileAnalysisService.get(localFilename, localPath)
    ])
  }

  async function appendLocalCandidate(
    id: number,
    localCandidate: UpgradeLocalCandidate
  ): Promise<UpgradeCase | null> {
    return withLocalCandidateWriteLock(id, async () => {
      const service = requireCollectionService()
      const upgradeCase = await service.upgradeCaseGet(id)
      if (!upgradeCase) return null

      const existingLocalCandidates = await service.upgradeCaseLocalCandidates(id)
      const nextLocalCandidates = existingLocalCandidates.some(
        (candidate) => candidate.filename === localCandidate.filename
      )
        ? existingLocalCandidates
        : [...existingLocalCandidates, localCandidate]
      const selectedLocalFilename = upgradeCase.selectedLocalFilename ?? localCandidate.filename
      const selectedCandidate =
        upgradeCase.selectedLocalFilename != null
          ? upgradeCase.selectedCandidate
          : findSelectedCandidate(await service.upgradeCaseCandidates(id), localCandidate)

      const updated = await service.upgradeCaseUpdate(id, {
        status: 'downloaded',
        localCandidatesJson: JSON.stringify(nextLocalCandidates),
        selectedLocalFilename,
        selectedCandidateJson: selectedCandidate ? JSON.stringify(selectedCandidate) : null,
        lastError: null
      })
      void warmUpgradeAnalysis(upgradeCase.collectionFilename, localCandidate.filename)
      return updated
    })
  }

  async function continueDownloadPipeline(id: number, candidate: UpgradeCandidate): Promise<void> {
    const service = requireCollectionService()
    const settings = currentSettings()

    try {
      const result = await slskdService.waitForDownload(settings, candidate.username, candidate.filename)
      if (result !== 'Completed') {
        const upgradeCase = await service.upgradeCaseGet(id)
        await service.upgradeCaseUpdate(id, {
          status: getDownloadFailureStatus(upgradeCase),
          lastError:
            result === 'Timeout' ? 'Download timed out.' : 'Download failed or was cancelled.'
        })
        return
      }

      const localPath = await importService.resolveLocalPath(settings, candidate.filename)
      if (!localPath) {
        const upgradeCase = await service.upgradeCaseGet(id)
        await service.upgradeCaseUpdate(id, {
          status: getDownloadFailureStatus(upgradeCase),
          lastError: 'Downloaded file was not found in the configured download folders.'
        })
        return
      }

      await appendLocalCandidate(
        id,
        await buildLocalCandidate(
          toMusicRelativePath(settings, localPath),
          'auto_download',
          candidate.username,
          candidate.filename
        )
      )
    } catch (error) {
      const upgradeCase = await service.upgradeCaseGet(id)
      await service.upgradeCaseUpdate(id, {
        status: getDownloadFailureStatus(upgradeCase),
        lastError: error instanceof Error ? error.message : 'Download failed'
      })
    }
  }

  async function queueUpgradeDownload(id: number, candidate: UpgradeCandidate): Promise<void> {
    const service = requireCollectionService()

    try {
      await slskdService.downloadFile(currentSettings(), candidate.username, candidate.filename, candidate.size)
      await service.upgradeCaseUpdate(id, { status: 'downloading', lastError: null })
      void continueDownloadPipeline(id, candidate)
    } catch (error) {
      const upgradeCase = await service.upgradeCaseGet(id)
      await service.upgradeCaseUpdate(id, {
        status: getDownloadFailureStatus(upgradeCase),
        lastError: error instanceof Error ? error.message : 'Download failed'
      })
    }
  }

  async function openCase(collectionFilename: string): Promise<UpgradeCase> {
    const service = requireCollectionService()
    const absolutePath = resolveMusicRelativePath(collectionFilename)
    const parsed = parseSongFilename(basename(absolutePath))
    if (!parsed) {
      throw new HttpError(400, `Cannot parse filename: ${basename(absolutePath)}`)
    }

    const existing = await service.upgradeCaseGetByCollectionFilename(collectionFilename)
    const searchArtist = existing?.searchArtist || parsed.artist
    const searchTitle = existing?.searchTitle || parsed.title
    const searchVersion = existing?.searchVersion ?? parsed.version
    const currentDurationSeconds = await getAudioDuration(absolutePath)
    const reference = await resolveUpgradeReference(
      currentSettings(),
      discogsMatchService,
      onlineSearchService,
      searchArtist,
      searchTitle,
      searchVersion,
      currentDurationSeconds
    )

    const upgradeCase = await service.upgradeCaseAdd({
      collectionFilename,
      searchArtist,
      searchTitle,
      searchVersion,
      currentDurationSeconds,
      officialDurationSeconds: reference.officialDurationSeconds,
      officialDurationSource: reference.officialDurationSource,
      referenceDurationSeconds: reference.referenceDurationSeconds,
      referenceDurationSource: reference.referenceDurationSource
    })

    if (
      upgradeCase.status === 'searching' ||
      upgradeCase.status === 'downloading' ||
      upgradeCase.status === 'pending_reanalyze' ||
      upgradeCase.status === 'completed' ||
      upgradeCase.candidateCount > 0 ||
      upgradeCase.localCandidateCount > 0
    ) {
      return upgradeCase
    }

    const updated = await service.upgradeCaseUpdate(upgradeCase.id, {
      status: 'searching',
      currentDurationSeconds,
      officialDurationSeconds: reference.officialDurationSeconds,
      officialDurationSource: reference.officialDurationSource,
      referenceDurationSeconds: reference.referenceDurationSeconds,
      referenceDurationSource: reference.referenceDurationSource,
      candidateCacheJson: null,
      selectedCandidateJson: null,
      lastError: null,
      completedAt: null
    })
    void continueSearchPipeline(upgradeCase.id)
    return updated ?? upgradeCase
  }

  async function continueSearchPipeline(id: number): Promise<void> {
    const service = requireCollectionService()
    const settings = currentSettings()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return

    if (!settings.slskdBaseURL || !settings.slskdApiKey) {
      await service.upgradeCaseUpdate(id, {
        status: 'error',
        lastError: 'slskd is not configured.'
      })
      return
    }

    try {
      const query = slskdService.buildSearchQuery(
        upgradeCase.searchArtist,
        upgradeCase.searchTitle,
        upgradeCase.searchVersion
      )
      const searchId = await slskdService.startSearch(settings, query)
      const search = await slskdService.waitForResults(settings, searchId)
      const candidates = slskdService
        .extractCandidates(
          upgradeCase.searchArtist,
          upgradeCase.searchTitle,
          upgradeCase.searchVersion,
          search
        )
        .map((candidate) => buildUpgradeCandidate(candidate, upgradeCase.referenceDurationSeconds))
        .sort(compareUpgradeCandidates)

      const updated = await service.upgradeCaseUpdate(id, {
        status: candidates.length > 0 ? 'results_ready' : 'no_results',
        candidateCacheJson: JSON.stringify(candidates),
        selectedCandidateJson: null,
        lastError: null,
        completedAt: null
      })
      const autoDownloads = pickUpgradeAutoDownloads(candidates)
      if (!updated || autoDownloads.length === 0) {
        return
      }
      await service.upgradeCaseUpdate(id, { status: 'downloading' })
      await Promise.allSettled(autoDownloads.map((candidate) => queueUpgradeDownload(id, candidate)))
    } catch (error) {
      await service.upgradeCaseUpdate(id, {
        status: 'error',
        lastError: error instanceof Error ? error.message : 'Search failed'
      })
    }
  }

  async function searchCase(
    id: number,
    searchInput: { artist?: string; title?: string; version?: string | null } | null | undefined
  ): Promise<UpgradeCase | null> {
    const service = requireCollectionService()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return null

    const searchArtist = normalizeSearchText(searchInput?.artist) || upgradeCase.searchArtist
    const searchTitle = normalizeSearchText(searchInput?.title) || upgradeCase.searchTitle
    const searchVersion =
      typeof searchInput?.version === 'string'
        ? normalizeSearchText(searchInput.version) || null
        : searchInput?.version === null
          ? null
          : upgradeCase.searchVersion
    if (!searchArtist || !searchTitle) {
      return await service.upgradeCaseUpdate(id, {
        status: 'error',
        lastError: 'Artist and title are required.'
      })
    }

    const currentDurationSeconds = await getAudioDuration(resolveMusicRelativePath(upgradeCase.collectionFilename))
    const reference = await resolveUpgradeReference(
      currentSettings(),
      discogsMatchService,
      onlineSearchService,
      searchArtist,
      searchTitle,
      searchVersion,
      currentDurationSeconds
    )

    const updated = await service.upgradeCaseUpdate(id, {
      status: 'searching',
      searchArtist,
      searchTitle,
      searchVersion,
      currentDurationSeconds,
      officialDurationSeconds: reference.officialDurationSeconds,
      officialDurationSource: reference.officialDurationSource,
      referenceDurationSeconds: reference.referenceDurationSeconds,
      referenceDurationSource: reference.referenceDurationSource,
      candidateCacheJson: null,
      selectedCandidateJson: null,
      lastError: null,
      completedAt: null
    })

    void continueSearchPipeline(id)
    return updated
  }

  async function setReference(
    id: number,
    input: { artist?: string; title?: string; version?: string | null; durationSeconds?: number | null }
  ): Promise<UpgradeCase | null> {
    const service = requireCollectionService()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return null

    const searchArtist = normalizeSearchText(input.artist) || upgradeCase.searchArtist
    const searchTitle = normalizeSearchText(input.title) || upgradeCase.searchTitle
    const searchVersion =
      typeof input.version === 'string'
        ? normalizeSearchText(input.version) || null
        : input.version === null
          ? null
          : upgradeCase.searchVersion
    const currentDurationSeconds = await getAudioDuration(
      resolveMusicRelativePath(upgradeCase.collectionFilename)
    )
    const officialDurationSeconds =
      typeof input.durationSeconds === 'number' && isFinite(input.durationSeconds)
        ? input.durationSeconds
        : null
    const updated = await service.upgradeCaseUpdate(id, {
      status: 'searching',
      searchArtist,
      searchTitle,
      searchVersion,
      currentDurationSeconds,
      officialDurationSeconds,
      officialDurationSource: officialDurationSeconds != null ? 'discogs' : null,
      referenceDurationSeconds: officialDurationSeconds ?? currentDurationSeconds,
      referenceDurationSource:
        officialDurationSeconds != null ? 'discogs' : currentDurationSeconds != null ? 'current_file' : null,
      candidateCacheJson: null,
      selectedCandidateJson: null,
      lastError: null,
      completedAt: null
    })

    void continueSearchPipeline(id)
    return updated
  }

  async function startDownloadPipeline(
    id: number,
    username: string,
    filename: string,
    size: number
  ): Promise<UpgradeCase | null> {
    const service = requireCollectionService()
    const settings = currentSettings()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return null

    const selectedCandidate = (await service.upgradeCaseCandidates(id)).find(
      (candidate) =>
        candidate.username === username && candidate.filename === filename && candidate.size === size
    )
    if (!selectedCandidate) {
      throw new HttpError(400, 'Candidate no longer exists in the cached search results.')
    }

    void settings
    await queueUpgradeDownload(id, selectedCandidate)
    return await service.upgradeCaseGet(id)
  }

  async function addLocalCandidate(id: number, filename: string): Promise<UpgradeCase | null> {
    const service = requireCollectionService()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return null
    return appendLocalCandidate(
      id,
      await buildLocalCandidate(normalizeFilename(filename), 'import_folder', null, null)
    )
  }

  async function getLocalCandidates(id: number): Promise<UpgradeLocalCandidate[]> {
    return await requireCollectionService().upgradeCaseLocalCandidates(id)
  }

  async function selectLocalCandidate(id: number, filename: string): Promise<UpgradeCase | null> {
    const service = requireCollectionService()
    const localCandidate = (await service
      .upgradeCaseLocalCandidates(id))
      .find((candidate) => candidate.filename === normalizeFilename(filename))
    if (!localCandidate) {
      throw new HttpError(404, 'Local candidate not found.')
    }

    const selectedCandidate = findSelectedCandidate(await service.upgradeCaseCandidates(id), localCandidate)
    return await service.upgradeCaseUpdate(id, {
      status: 'downloaded',
      selectedLocalFilename: localCandidate.filename,
      selectedCandidateJson: selectedCandidate ? JSON.stringify(selectedCandidate) : null,
      lastError: null
    })
  }

  async function replaceCase(id: number): Promise<UpgradeCase | null> {
    const service = requireCollectionService()
    const settings = currentSettings()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return null
    if (!upgradeCase.selectedLocalFilename) {
      throw new HttpError(400, 'Select a local candidate before replacing the current file.')
    }

    const collectionPath = resolveMusicRelativePath(upgradeCase.collectionFilename)
    const localCandidatePath = resolveMusicRelativePath(upgradeCase.selectedLocalFilename)
    const parsed =
      parseImportFilename(upgradeCase.collectionFilename) ??
      parseImportFilename(upgradeCase.selectedLocalFilename)
    if (!parsed) {
      throw new HttpError(400, 'Cannot derive replacement metadata from the current or selected file.')
    }

    const archiveDate = new Date().toISOString().slice(0, 10)
    const songsPrefix = normalizeFilename(settings.songsFolderPath)
    const normalizedCollectionFilename = normalizeFilename(upgradeCase.collectionFilename)
    const archiveSuffix = normalizedCollectionFilename.startsWith(`${songsPrefix}/`)
      ? normalizedCollectionFilename.slice(songsPrefix.length + 1)
      : basename(normalizedCollectionFilename)
    const desiredArchiveRelativePath = normalizeFilename(
      join(settings.songsFolderPath, '_replaced', archiveDate, archiveSuffix)
    )
    const archivePath = await findAvailableArchivePath(resolveMusicRelativePath(desiredArchiveRelativePath))
    const archiveRelativePath = toMusicRelativePath(settings, archivePath)
    const replacementRelativePath = buildReplacementRelativePath(
      upgradeCase.collectionFilename,
      upgradeCase.selectedLocalFilename
    )

    const match = {
      releaseId: 0,
      releaseTitle: parsed.title,
      format: null,
      artist: upgradeCase.searchArtist || parsed.artist,
      title: upgradeCase.searchTitle || parsed.title,
      version: upgradeCase.searchVersion ?? parsed.version,
      trackPosition: null,
      year: parsed.year,
      label: null,
      catalogNumber: null,
      score: 100
    }

    await mkdir(dirname(archivePath), { recursive: true })
    await copyFile(collectionPath, archivePath)

    const result = await importService.importFileWithKnownMatch(settings, match, localCandidatePath, null, {
      conflictStrategy: 'replace',
      replaceRelativePath: replacementRelativePath
    })
    if (result.status !== 'replaced') {
      throw new HttpError(400, result.status === 'error' ? result.message : 'Replacement failed.')
    }

    if (normalizeFilename(replacementRelativePath) !== normalizedCollectionFilename) {
      await unlink(collectionPath).catch(() => {})
    }
    await service.syncNow()

    return await service.upgradeCaseUpdate(id, {
      collectionFilename: replacementRelativePath,
      status: 'pending_reanalyze',
      archiveFilename: archiveRelativePath,
      replacementFilename: replacementRelativePath,
      lastError: null,
      completedAt: null
    })
  }

  async function listCases(): Promise<UpgradeCase[]> {
    return await requireCollectionService().upgradeCaseList()
  }

  async function getCase(id: number): Promise<UpgradeCase | null> {
    return await requireCollectionService().upgradeCaseGet(id)
  }

  async function getCandidates(id: number): Promise<UpgradeCandidate[]> {
    return await requireCollectionService().upgradeCaseCandidates(id)
  }

  async function markReanalyzed(id: number): Promise<UpgradeCase | null> {
    return await requireCollectionService().upgradeCaseUpdate(id, {
      status: 'completed',
      lastError: null,
      completedAt: new Date().toISOString()
    })
  }

  return {
    listCases,
    getCase,
    openCase,
    searchCase,
    setReference,
    getCandidates,
    getLocalCandidates,
    startDownloadPipeline,
    addLocalCandidate,
    selectLocalCandidate,
    replaceCase,
    markReanalyzed
  }
}

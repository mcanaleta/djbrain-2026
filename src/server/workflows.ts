import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { CollectionService, WantListItem } from '../backend/collection-service.ts'
import { FileAnalysisService } from '../backend/file-analysis-service.ts'
import { ImportProcessingQueue } from '../backend/import-processing-queue.ts'
import { ImportReviewService } from '../backend/import-review-service.ts'
import { ImportService, parseSongFilename } from '../backend/import-service.ts'
import type { AppSettings } from '../backend/settings-store.ts'
import { SlskdService } from '../backend/slskd-service.ts'
import {
  AUDIO_ANALYSIS_VERSION,
  AUDIO_HASH_VERSION,
  IMPORT_REVIEW_VERSION
} from '../shared/analysis-version.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
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
        const cached = requireCollectionService().readImportReviewCache(filename)
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
        requireCollectionService().saveImportReviewCache(filename, {
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
      service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'error',
        pipelineError: 'slskd is not configured.'
      })
      return
    }

    const artist = item.artist.trim()
    const title = item.title.trim()
    const version = item.version?.trim() || null
    if (!artist || !title) {
      service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'error',
        pipelineError: 'Want list item is missing artist or title.'
      })
      return
    }

    try {
      const query =
        normalizeSearchText(queryOverride) || slskdService.buildSearchQuery(artist, title, version)
      const searchId = await slskdService.startSearch(settings, query)
      service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'searching',
        searchId,
        pipelineError: null
      })

      const search = await slskdService.waitForResults(settings, searchId)
      const candidates = slskdService.extractCandidates(artist, title, version, search)
      service.wantListUpdatePipeline(item.id, {
        pipelineStatus: candidates.length > 0 ? 'results_ready' : 'no_results',
        searchResultCount: candidates.length,
        bestCandidatesJson: candidates.length > 0 ? JSON.stringify(candidates) : null
      })
    } catch (error) {
      service.wantListUpdatePipeline(item.id, {
        pipelineStatus: 'error',
        pipelineError: error instanceof Error ? error.message : 'Search failed'
      })
    }
  }

  async function runImportPipeline(itemId: number, localFilePath: string): Promise<void> {
    const service = requireCollectionService()
    const settings = currentSettings()
    const item = service.wantListGet(itemId)
    if (!item) {
      return
    }

    if (!item.artist || !item.title || !item.year) {
      service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'import_error',
        pipelineError:
          'Artist, title, and year are required before importing. Fill them in and save.'
      })
      return
    }

    service.wantListUpdatePipeline(itemId, {
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
        service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'imported',
          discogsReleaseId: result.match.releaseId,
          discogsTrackPosition: result.match.trackPosition,
          importedFilename: result.destRelativePath
        })
      } else if (result.status === 'skipped_existing') {
        service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'imported',
          discogsReleaseId: result.match.releaseId,
          discogsTrackPosition: result.match.trackPosition,
          importedFilename: result.existingRelativePath
        })
      } else {
        service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'import_error',
          pipelineError: result.status === 'error' ? result.message : 'Import failed'
        })
      }
    } catch (error) {
      service.wantListUpdatePipeline(itemId, {
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
        service.wantListUpdatePipeline(itemId, {
          pipelineStatus: 'error',
          pipelineError:
            result === 'Timeout' ? 'Download timed out' : 'Download failed or was cancelled'
        })
        return
      }

      service.wantListUpdatePipeline(itemId, { pipelineStatus: 'downloaded' })

      const localPath = await importService.resolveLocalPath(settings, filename)
      if (localPath) {
        void runImportPipeline(itemId, localPath)
      }
    } catch (error) {
      console.error(`[slskd] download pipeline failed: user=${username} file=${filename}`, error)
      service.wantListUpdatePipeline(itemId, {
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
      const existing = service.wantListGet(itemId)
      if (!existing) {
        return null
      }

      await slskdService.downloadFile(settings, username, filename, size)
      const updated = service.wantListUpdatePipeline(itemId, {
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

import { basename, join } from 'node:path'
import { unlink } from 'node:fs/promises'
import type { Express } from 'express'
import type { CollectionService } from '../../backend/collection-service.ts'
import { FileAnalysisService } from '../../backend/file-analysis-service.ts'
import { ImportService, parseSongFilename } from '../../backend/import-service.ts'
import type { PostgresMediaStore } from '../../backend/postgres-media-store.ts'
import type { AppSettings } from '../../backend/settings-store.ts'
import type { DiscogsTrackMatch } from '../../shared/discogs-match.ts'
import type { ImportTagPreview } from '../../shared/api.ts'
import { asyncHandler, sendEmpty, sendJson } from '../http.ts'

type CollectionRouteDeps = {
  requireCollectionService: () => CollectionService
  automationEnabled: boolean
  currentSettings: () => AppSettings
  readCollectionStatus: () => Promise<unknown>
  buildImportReview: (filename: string, searchValue?: unknown, force?: boolean) => Promise<unknown>
  fileAnalysisService: FileAnalysisService
  importService: ImportService
  syncImportReviewQueue: () => Promise<void>
  syncIdentificationQueue: () => Promise<void>
  resolveMusicRelativePath: (filename: string) => string
  normalizeFilename: (value: string) => string
  getAudioDuration: (filePath: string) => Promise<number | null>
  clearEmptyDirsWithin: (rootDir: string) => Promise<number>
  showInFolder: (filePath: string) => Promise<void>
  openInSystemPlayer: (filePath: string) => Promise<void>
  readDiscogsTrackMatch: (value: unknown) => DiscogsTrackMatch | null
  readImportTagPreview: (value: unknown) => ImportTagPreview | null
  applyTagOverrides: (
    match: DiscogsTrackMatch,
    tags: ImportTagPreview | null
  ) => DiscogsTrackMatch
  getMediaStore?: () => PostgresMediaStore | null
  syncMediaCatalog?: () => Promise<void>
  syncMediaItem?: (filename: string) => Promise<void>
}

export function registerCollectionRoutes(app: Express, deps: CollectionRouteDeps): void {
  const {
    requireCollectionService,
    automationEnabled,
    currentSettings,
    readCollectionStatus,
    buildImportReview,
    fileAnalysisService,
    importService,
    syncImportReviewQueue,
    syncIdentificationQueue,
    resolveMusicRelativePath,
    normalizeFilename,
    getAudioDuration,
    clearEmptyDirsWithin,
    showInFolder,
    openInSystemPlayer,
    readDiscogsTrackMatch,
    readImportTagPreview,
    applyTagOverrides,
    getMediaStore,
    syncMediaCatalog,
    syncMediaItem
  } = deps

  app.get('/api/collection', asyncHandler(async (request, response) => {
    const query = typeof request.query['query'] === 'string' ? request.query['query'] : ''
    const limitRaw = Number(request.query['limit'])
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : undefined
    const mediaStore = getMediaStore?.() ?? null
    if (mediaStore) {
      try {
        sendJson(response, 200, await mediaStore.list(query, limit))
        return
      } catch {
        // Fall back to primary collection store if the read model is unavailable.
      }
    }
    sendJson(response, 200, await requireCollectionService().list(query, limit))
  }))

  app.get('/api/collection/item', asyncHandler(async (request, response) => {
    const filenameRaw = typeof request.query['filename'] === 'string' ? request.query['filename'] : ''
    const filename = filenameRaw ? normalizeFilename(filenameRaw) : ''
    if (!filename) {
      sendJson(response, 200, null)
      return
    }
    const mediaStore = getMediaStore?.() ?? null
    if (mediaStore) {
      const item = await mediaStore.get(filename)
      if (item) {
        item.upgradeCase = await requireCollectionService().upgradeCaseGetByCollectionFilename(filename)
        sendJson(response, 200, item)
        return
      }
    }
    sendJson(response, 200, await requireCollectionService().getItem(filename))
  }))

  app.get(
    '/api/collection/downloads',
    asyncHandler(async (request, response) => {
      const service = requireCollectionService()
      const query = typeof request.query['query'] === 'string' ? request.query['query'] : ''
      const result = await service.listDownloads(query)
      const musicFolderPath = currentSettings().musicFolderPath
      const items = await Promise.all(
        result.items.map(async (item) => ({
          ...item,
          duration: await getAudioDuration(join(musicFolderPath, item.filename))
        }))
      )
      sendJson(response, 200, { items, total: result.total })
    })
  )

  app.get(
    '/api/collection/status',
    asyncHandler(async (_request, response) => {
      sendJson(response, 200, await readCollectionStatus())
    })
  )

  app.post(
    '/api/collection/sync',
    asyncHandler(async (_request, response) => {
      await requireCollectionService().syncNow()
      await syncMediaCatalog?.()
      sendJson(response, 200, await readCollectionStatus())
    })
  )

  app.post(
    '/api/collection/import/review',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as {
        filename?: string
        search?: { artist?: string; title?: string; version?: string | null } | null
        force?: boolean
      } | null
      const filename = typeof body?.filename === 'string' ? body.filename : ''
      sendJson(response, 200, await buildImportReview(filename, body?.search, body?.force === true))
    })
  )

  app.post(
    '/api/collection/import/process',
    asyncHandler(async (request, response) => {
      if (!automationEnabled) {
        sendJson(response, 200, { queued: 0 })
        return
      }
      const body = (request.body ?? null) as { filenames?: string[] | null; force?: boolean } | null
      const filenames = Array.isArray(body?.filenames)
        ? body.filenames.filter((value): value is string => typeof value === 'string')
        : []
      const queued = await requireCollectionService().queueImportReviewFiles(
        filenames,
        body?.force === true
      )
      if (queued > 0) {
        await syncImportReviewQueue()
      }
      sendJson(response, 200, { queued })
    })
  )

  app.post(
    '/api/collection/identify/process',
    asyncHandler(async (request, response) => {
      if (!automationEnabled) {
        sendJson(response, 200, { queued: 0 })
        return
      }
      const body = (request.body ?? null) as { filenames?: string[] | null; force?: boolean } | null
      const filenames = Array.isArray(body?.filenames)
        ? body.filenames.filter((value): value is string => typeof value === 'string')
        : []
      const queued = await requireCollectionService().queueIdentificationFiles(filenames, body?.force === true)
      if (queued > 0) await syncIdentificationQueue()
      sendJson(response, 200, { queued })
    })
  )

  app.post(
    '/api/collection/identify/review',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as {
        filename?: string
        action?: 'accept' | 'reject' | 'create_recording'
        candidateId?: number | null
      } | null
      const filename = typeof body?.filename === 'string' ? normalizeFilename(body.filename) : ''
      if (!filename || !body?.action) {
        sendJson(response, 400, { message: 'filename and action are required.' })
        return
      }
      sendJson(
        response,
        200,
        await requireCollectionService().reviewIdentification(
          filename,
          body.action,
          typeof body.candidateId === 'number' ? body.candidateId : null
        )
      )
    })
  )

  app.get(
    '/api/collection/recordings',
    asyncHandler(async (request, response) => {
      const query = typeof request.query['query'] === 'string' ? request.query['query'] : ''
      sendJson(response, 200, await requireCollectionService().listRecordings(query))
    })
  )

  app.get(
    '/api/collection/recordings/:id',
    asyncHandler(async (request, response) => {
      const id = Number(request.params['id'])
      sendJson(response, 200, Number.isFinite(id) ? await requireCollectionService().getRecording(id) : null)
    })
  )

  app.post(
    '/api/collection/recordings/assign',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as {
        recordingId?: number | null
        filenames?: string[] | null
        create?: boolean
        canonical?: { artist?: string | null; title?: string | null; version?: string | null; year?: string | null } | null
      } | null
      const filenames = Array.isArray(body?.filenames)
        ? body.filenames.filter((value): value is string => typeof value === 'string').map(normalizeFilename)
        : []
      sendJson(
        response,
        200,
        await requireCollectionService().assignRecording({
          recordingId: typeof body?.recordingId === 'number' ? body.recordingId : null,
          filenames,
          create: body?.create === true,
          canonical: body?.canonical ?? null
        })
      )
    })
  )

  app.post(
    '/api/collection/recordings/merge',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { sourceRecordingId?: number | null; targetRecordingId?: number | null } | null
      if (typeof body?.sourceRecordingId !== 'number' || typeof body?.targetRecordingId !== 'number') {
        sendJson(response, 400, { message: 'sourceRecordingId and targetRecordingId are required.' })
        return
      }
      sendJson(
        response,
        200,
        await requireCollectionService().mergeRecordings(body.sourceRecordingId, body.targetRecordingId)
      )
    })
  )

  app.post(
    '/api/collection/reanalyze',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string | null } | null
      const filenameRaw = typeof body?.filename === 'string' ? body.filename : ''
      const filename = normalizeFilename(filenameRaw)
      if (!filename) {
        sendJson(response, 400, { message: 'filename is required' })
        return
      }
      resolveMusicRelativePath(filename)
      const service = requireCollectionService()
      const invalidated = await service.invalidateAudioAnalysis(filename)
      if (!invalidated) {
        sendJson(response, 404, { message: 'File not found in collection.' })
        return
      }
      await fileAnalysisService.get(filename, resolveMusicRelativePath(filename))
      if (syncMediaItem) await syncMediaItem(filename)
      else await syncMediaCatalog?.()
      sendJson(response, 200, { ok: true })
    })
  )

  app.post(
    '/api/collection/import/compare',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string; existingFilename?: string } | null
      const filename = typeof body?.filename === 'string' ? body.filename : ''
      const existingFilename = typeof body?.existingFilename === 'string' ? body.existingFilename : ''
      const [sourceAnalysis, existingAnalysis] = await Promise.all([
        fileAnalysisService.get(filename, resolveMusicRelativePath(filename)),
        fileAnalysisService.get(existingFilename, resolveMusicRelativePath(existingFilename))
      ])
      sendJson(response, 200, { sourceFilename: filename, existingFilename, sourceAnalysis, existingAnalysis })
    })
  )

  app.post(
    '/api/collection/import',
    asyncHandler(async (request, response) => {
      const service = requireCollectionService()
      const body = (request.body ?? null) as {
        filename?: string
        match?: DiscogsTrackMatch | null
        tags?: ImportTagPreview | null
        mode?: 'import_new' | 'replace_existing'
        replaceFilename?: string | null
      } | null
      const filename = typeof body?.filename === 'string' ? body.filename : ''
      const settings = currentSettings()
      const absolutePath = resolveMusicRelativePath(filename)
      const replaceFilename =
        typeof body?.replaceFilename === 'string' && body.replaceFilename.trim()
          ? normalizeFilename(body.replaceFilename)
          : null

      if (replaceFilename) {
        resolveMusicRelativePath(replaceFilename)
      }

      const providedMatch = readDiscogsTrackMatch(body?.match)
      const tagOverrides = readImportTagPreview(body?.tags)
      const result = providedMatch
        ? await importService.importFileWithKnownMatch(
            settings,
            applyTagOverrides(providedMatch, tagOverrides),
            absolutePath,
            null,
            {
              conflictStrategy: body?.mode === 'replace_existing' ? 'replace' : 'keep_both',
              replaceRelativePath: replaceFilename
            }
          )
        : await (async () => {
            const parsed = parseSongFilename(basename(absolutePath))
            if (!parsed) {
              return {
                status: 'error',
                message: `Cannot parse filename: ${basename(absolutePath)}`
              } as const
            }
            return importService.importFile(settings, parsed.artist, parsed.title, parsed.version, absolutePath)
          })()

      void service.syncNow().then(async () => {
        if (!syncMediaItem) {
          await syncMediaCatalog?.()
          return
        }
        const changed = new Set<string>()
        if (result.status === 'imported' || result.status === 'imported_upgrade') {
          changed.add(normalizeFilename(result.destRelativePath))
        }
        if (result.status === 'replaced') {
          changed.add(normalizeFilename(result.replacedRelativePath))
        }
        if (result.status === 'skipped_existing') {
          changed.add(normalizeFilename(result.existingRelativePath))
        }
        await Promise.all([...changed].map((item) => syncMediaItem(item)))
      })

      if (result.status === 'imported') {
        sendJson(response, 200, { status: 'imported', destRelativePath: result.destRelativePath })
        return
      }
      if (result.status === 'imported_upgrade') {
        sendJson(response, 200, {
          status: 'imported_upgrade',
          destRelativePath: result.destRelativePath,
          existingRelativePath: result.existingRelativePath
        })
        return
      }
      if (result.status === 'skipped_existing') {
        sendJson(response, 200, {
          status: 'skipped_existing',
          existingRelativePath: result.existingRelativePath
        })
        return
      }
      if (result.status === 'replaced') {
        sendJson(response, 200, {
          status: 'replaced',
          replacedRelativePath: result.replacedRelativePath
        })
        return
      }
      if (result.status === 'needs_review') {
        sendJson(response, 200, { status: 'needs_review' })
        return
      }

      sendJson(response, 400, { status: 'error', message: result.message })
    })
  )

  app.delete(
    '/api/collection/file',
    asyncHandler(async (request, response) => {
      const service = requireCollectionService()
      const body = (request.body ?? null) as { filename?: string } | null
      const filename = typeof body?.filename === 'string' ? body.filename : ''
      await unlink(resolveMusicRelativePath(filename))
      void service.syncNow().then(async () => {
        if (syncMediaItem) await syncMediaItem(normalizeFilename(filename))
        else await syncMediaCatalog?.()
      })
      sendEmpty(response, 204)
    })
  )

  app.post(
    '/api/collection/clear-empty-folders',
    asyncHandler(async (_request, response) => {
      const service = requireCollectionService()
      const settings = currentSettings()
      let removed = 0
      for (const folder of settings.downloadFolderPaths) {
        removed += await clearEmptyDirsWithin(join(settings.musicFolderPath, normalizeFilename(folder)))
      }
      void service.syncNow().then(() => {
        void syncMediaCatalog?.()
      })
      sendJson(response, 200, { count: removed })
    })
  )

  app.post(
    '/api/collection/show-in-finder',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string } | null
      await showInFolder(resolveMusicRelativePath(typeof body?.filename === 'string' ? body.filename : ''))
      sendEmpty(response, 204)
    })
  )

  app.post(
    '/api/collection/open-in-player',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string } | null
      await openInSystemPlayer(
        resolveMusicRelativePath(typeof body?.filename === 'string' ? body.filename : '')
      )
      sendEmpty(response, 204)
    })
  )
}

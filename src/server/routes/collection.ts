import { basename, join } from 'node:path'
import { unlink } from 'node:fs/promises'
import type { Express } from 'express'
import type { CollectionService } from '../../backend/collection-service.ts'
import { FileAnalysisService } from '../../backend/file-analysis-service.ts'
import { ImportService, parseSongFilename } from '../../backend/import-service.ts'
import type { AppSettings } from '../../backend/settings-store.ts'
import type { DiscogsTrackMatch } from '../../shared/discogs-match.ts'
import type { ImportTagPreview } from '../../shared/api.ts'
import { asyncHandler, sendEmpty, sendJson } from '../http.ts'

type CollectionRouteDeps = {
  requireCollectionService: () => CollectionService
  currentSettings: () => AppSettings
  readCollectionStatus: () => Promise<unknown>
  buildImportReview: (filename: string, searchValue?: unknown, force?: boolean) => Promise<unknown>
  fileAnalysisService: FileAnalysisService
  importService: ImportService
  syncImportReviewQueue: () => Promise<void>
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
}

export function registerCollectionRoutes(app: Express, deps: CollectionRouteDeps): void {
  const {
    requireCollectionService,
    currentSettings,
    readCollectionStatus,
    buildImportReview,
    fileAnalysisService,
    importService,
    syncImportReviewQueue,
    resolveMusicRelativePath,
    normalizeFilename,
    getAudioDuration,
    clearEmptyDirsWithin,
    showInFolder,
    openInSystemPlayer,
    readDiscogsTrackMatch,
    readImportTagPreview,
    applyTagOverrides
  } = deps

  app.get('/api/collection', (request, response) => {
    const query = typeof request.query['query'] === 'string' ? request.query['query'] : ''
    sendJson(response, 200, requireCollectionService().list(query))
  })

  app.get(
    '/api/collection/downloads',
    asyncHandler(async (request, response) => {
      const service = requireCollectionService()
      const query = typeof request.query['query'] === 'string' ? request.query['query'] : ''
      const result = service.listDownloads(query)
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
      const body = (request.body ?? null) as { filenames?: string[] | null; force?: boolean } | null
      const filenames = Array.isArray(body?.filenames)
        ? body.filenames.filter((value): value is string => typeof value === 'string')
        : []
      const queued = requireCollectionService().queueImportReviewFiles(filenames, body?.force === true)
      if (queued > 0) {
        await syncImportReviewQueue()
      }
      sendJson(response, 200, { queued })
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

      void service.syncNow()

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
      void service.syncNow()
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
      void service.syncNow()
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

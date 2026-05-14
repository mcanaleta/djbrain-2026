import { isAbsolute, resolve } from 'node:path'
import type { Express } from 'express'
import type {
  CollectionService,
  WantListAddInput
} from '../../backend/collection-service.ts'
import type { SlskdCandidate } from '../../shared/api.ts'
import { HttpError, asyncHandler, sendEmpty, sendJson } from '../http.ts'

type WantListRouteDeps = {
  requireCollectionService: () => CollectionService
  normalizeSearchText: (value: string | null | undefined) => string
  resolveMusicRelativePath: (filename: string) => string
  runImportPipeline: (itemId: number, localFilePath: string) => Promise<void>
}

function parseStoredCandidates(value: string | null): SlskdCandidate[] {
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((candidate): candidate is SlskdCandidate => {
      return (
        typeof candidate === 'object' &&
        candidate !== null &&
        typeof candidate['username'] === 'string' &&
        typeof candidate['filename'] === 'string' &&
        typeof candidate['size'] === 'number' &&
        typeof candidate['score'] === 'number' &&
        typeof candidate['extension'] === 'string'
      )
    })
  } catch {
    return []
  }
}

export function registerWantListRoutes(app: Express, deps: WantListRouteDeps): void {
  const {
    requireCollectionService,
    normalizeSearchText,
    resolveMusicRelativePath,
    runImportPipeline
  } = deps

  app.get('/api/want-list', asyncHandler(async (_request, response) => {
    sendJson(response, 200, await requireCollectionService().wantListList())
  }))

  app.get('/api/want-list/:id', asyncHandler(async (request, response) => {
    const item = await requireCollectionService().wantListGet(Number(request.params['id']))
    sendJson(response, item ? 200 : 404, item ?? { message: 'Want list item not found' })
  }))

  app.post(
    '/api/want-list',
    asyncHandler(async (request, response) => {
      sendJson(response, 201, await requireCollectionService().wantListAdd((request.body ?? null) as WantListAddInput))
    })
  )

  app.put(
    '/api/want-list/:id',
    asyncHandler(async (request, response) => {
      const updated = await requireCollectionService().wantListUpdate(
        Number(request.params['id']),
        (request.body ?? null) as WantListAddInput
      )
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Want list item not found' })
    })
  )

  app.delete('/api/want-list/:id', asyncHandler(async (request, response) => {
    await requireCollectionService().wantListRemove(Number(request.params['id']))
    sendEmpty(response, 204)
  }))

  app.post('/api/want-list/:id/search', asyncHandler(async (request, response) => {
    const id = Number(request.params['id'])
    const service = requireCollectionService()
    const item = await service.wantListGet(id)
    if (!item) {
      sendJson(response, 404, { message: 'Want list item not found' })
      return
    }

    const updated = await service.wantListUpdatePipeline(id, {
      pipelineStatus: 'queued',
      searchId: null,
      searchResultCount: 0,
      bestCandidatesJson: null,
      nextSearchAt: new Date().toISOString(),
      pipelineError: null
    })
    sendJson(response, 200, updated)
  }))

  app.get('/api/want-list/:id/candidates', asyncHandler(async (request, response) => {
    const item = await requireCollectionService().wantListGet(Number(request.params['id']))
    sendJson(response, 200, parseStoredCandidates(item?.bestCandidatesJson ?? null))
  }))

  app.post(
    '/api/want-list/:id/download',
    asyncHandler(async (request, response) => {
      const id = Number(request.params['id'])
      const body = (request.body ?? null) as {
        username?: string
        filename?: string
        size?: number
      } | null
      const username = typeof body?.username === 'string' ? body.username.trim() : ''
      const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
      const size = typeof body?.size === 'number' ? body.size : 0

      if (!Number.isInteger(id) || id <= 0) {
        throw new HttpError(400, 'Want list item id is invalid.')
      }
      if (!username || !filename || size <= 0) {
        throw new HttpError(400, 'username, filename, and size are required.')
      }

      const service = requireCollectionService()
      const item = await service.wantListGet(id)
      if (!item) {
        sendJson(response, 404, { message: 'Want list item not found' })
        return
      }

      const candidate = parseStoredCandidates(item.bestCandidatesJson).find(
        (entry) => entry.username === username && entry.filename === filename && entry.size === size
      )
      const existing = (await service.downloadAttemptListForWantList(id)).find(
        (entry) => entry.username === username && entry.remoteFilename === filename && entry.remoteSize === size
      )
      if (!existing) {
        await service.downloadAttemptCreate({
          wantListId: id,
          status: 'queued',
          originArtist: item.artist,
          originTitle: item.title,
          originVersion: item.version,
          originYear: item.year,
          originAlbum: item.album,
          originLabel: item.label,
          originSourceCollectionFilename: item.sourceCollectionFilename,
          originDiscogsReleaseId: item.discogsReleaseId,
          originDiscogsTrackPosition: item.discogsTrackPosition,
          searchQuery: [item.artist, item.title, item.version].filter(Boolean).join(' '),
          slskdSearchId: item.searchId,
          username,
          remoteFilename: filename,
          remoteSize: size,
          bitrate: candidate?.bitrate ?? null,
          durationSeconds: candidate?.durationSeconds ?? null,
          extension: candidate?.extension ?? null,
          score: candidate?.score ?? null,
          queueLength: candidate?.queueLength ?? null,
          hasFreeUploadSlot: candidate?.hasFreeUploadSlot ?? null,
          uploadSpeed: candidate?.uploadSpeed ?? null,
          isLocked: candidate?.isLocked ?? false,
          expectedLocalFilename: service.expectedDownloadFilename(filename),
          rawCandidateJson: candidate ? JSON.stringify(candidate) : null
        })
      }
      sendJson(response, 200, await service.wantListUpdatePipeline(id, {
        pipelineStatus: 'downloading',
        downloadUsername: username,
        downloadFilename: filename,
        nextSearchAt: new Date().toISOString(),
        pipelineError: null
      }))
    })
  )

  app.get('/api/want-list/:id/downloads', asyncHandler(async (request, response) => {
    sendJson(response, 200, await requireCollectionService().downloadAttemptListForWantList(Number(request.params['id'])))
  }))

  app.post('/api/want-list/:id/downloads/:downloadId/select', asyncHandler(async (request, response) => {
    const updated = await requireCollectionService().wantListSelectDownload(Number(request.params['id']), Number(request.params['downloadId']))
    sendJson(response, updated ? 200 : 404, updated ?? { message: 'Download attempt not found' })
  }))

  app.post('/api/want-list/:id/import', asyncHandler(async (request, response) => {
    const id = Number(request.params['id'])
    const body = (request.body ?? null) as { localFilePath?: string; filename?: string; downloadId?: number } | null
    const selectedAttempt = typeof body?.downloadId === 'number'
      ? (await requireCollectionService().downloadAttemptListForWantList(id)).find((item) => item.id === body.downloadId)
      : null
    if (typeof body?.downloadId === 'number' && !selectedAttempt) throw new HttpError(404, 'Download attempt not found.')
    if (selectedAttempt && !selectedAttempt.localFilename) throw new HttpError(400, 'Selected download is not available locally yet.')
    const localFilePath = normalizeSearchText(body?.localFilePath ?? '')
    const filename = normalizeSearchText(selectedAttempt?.localFilename ?? body?.filename ?? '')
    if (!filename && !localFilePath) throw new HttpError(400, 'A downloaded file is required.')
    const fileToImport =
      localFilePath && isAbsolute(localFilePath)
        ? resolve(localFilePath)
        : resolveMusicRelativePath(filename || localFilePath)

    await runImportPipeline(id, fileToImport)
    sendJson(response, 200, await requireCollectionService().wantListGet(id))
  }))

  app.post('/api/want-list/:id/reset', asyncHandler(async (request, response) => {
    const updated = await requireCollectionService().wantListUpdatePipeline(Number(request.params['id']), {
      pipelineStatus: 'idle',
      searchId: null,
      searchResultCount: 0,
      bestCandidatesJson: null,
      downloadUsername: null,
      downloadFilename: null,
      nextSearchAt: null,
      selectedDownloadId: null,
      pipelineError: null
    })
    sendJson(response, 200, updated)
  }))
}

import { resolve } from 'node:path'
import type { Express } from 'express'
import type {
  CollectionService,
  WantListAddInput,
  WantListItem
} from '../../backend/collection-service.ts'
import type { SlskdCandidate } from '../../shared/api.ts'
import { HttpError, asyncHandler, sendEmpty, sendJson } from '../http.ts'

type WantListRouteDeps = {
  requireCollectionService: () => CollectionService
  normalizeSearchText: (value: string | null | undefined) => string
  resolveMusicRelativePath: (filename: string) => string
  runSearchPipeline: (item: WantListItem, queryOverride?: string) => Promise<void>
  runImportPipeline: (itemId: number, localFilePath: string) => Promise<void>
  startDownloadPipeline: (
    itemId: number,
    username: string,
    filename: string,
    size: number
  ) => Promise<WantListItem | null>
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
    runSearchPipeline,
    runImportPipeline,
    startDownloadPipeline
  } = deps

  app.get('/api/want-list', (_request, response) => {
    sendJson(response, 200, requireCollectionService().wantListList())
  })

  app.get('/api/want-list/:id', (request, response) => {
    const item = requireCollectionService().wantListGet(Number(request.params['id']))
    sendJson(response, item ? 200 : 404, item ?? { message: 'Want list item not found' })
  })

  app.post(
    '/api/want-list',
    asyncHandler(async (request, response) => {
      const item = requireCollectionService().wantListAdd((request.body ?? null) as WantListAddInput)
      void runSearchPipeline(item)
      sendJson(response, 201, item)
    })
  )

  app.put(
    '/api/want-list/:id',
    asyncHandler(async (request, response) => {
      const updated = requireCollectionService().wantListUpdate(
        Number(request.params['id']),
        (request.body ?? null) as WantListAddInput
      )
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Want list item not found' })
    })
  )

  app.delete('/api/want-list/:id', (request, response) => {
    requireCollectionService().wantListRemove(Number(request.params['id']))
    sendEmpty(response, 204)
  })

  app.post('/api/want-list/:id/search', (request, response) => {
    const id = Number(request.params['id'])
    const service = requireCollectionService()
    const item = service.wantListGet(id)
    if (!item) {
      sendJson(response, 404, { message: 'Want list item not found' })
      return
    }

    const body = (request.body ?? null) as { query?: string } | null
    const query = typeof body?.query === 'string' ? body.query : ''
    const updated = service.wantListUpdatePipeline(id, {
      pipelineStatus: 'searching',
      searchId: null,
      searchResultCount: 0,
      bestCandidatesJson: null,
      pipelineError: null
    })

    void runSearchPipeline(item, query)
    sendJson(response, 200, updated)
  })

  app.get('/api/want-list/:id/candidates', (request, response) => {
    const item = requireCollectionService().wantListGet(Number(request.params['id']))
    sendJson(response, 200, parseStoredCandidates(item?.bestCandidatesJson ?? null))
  })

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

      const item = await startDownloadPipeline(id, username, filename, size)
      sendJson(response, item ? 200 : 404, item ?? { message: 'Want list item not found' })
    })
  )

  app.post('/api/want-list/:id/import', (request, response) => {
    const id = Number(request.params['id'])
    const body = (request.body ?? null) as { localFilePath?: string; filename?: string } | null
    const localFilePath = normalizeSearchText(body?.localFilePath ?? '')
    const filename = normalizeSearchText(body?.filename ?? '')
    const fileToImport =
      localFilePath.startsWith('/')
        ? resolve(localFilePath)
        : resolveMusicRelativePath(filename || localFilePath)

    void runImportPipeline(id, fileToImport)
    sendJson(response, 202, requireCollectionService().wantListGet(id))
  })

  app.post('/api/want-list/:id/reset', (request, response) => {
    const updated = requireCollectionService().wantListUpdatePipeline(Number(request.params['id']), {
      pipelineStatus: 'idle',
      searchId: null,
      searchResultCount: 0,
      bestCandidatesJson: null,
      downloadUsername: null,
      downloadFilename: null,
      pipelineError: null
    })
    sendJson(response, 200, updated)
  })
}

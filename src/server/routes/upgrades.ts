import type { Express } from 'express'
import { HttpError, asyncHandler, sendJson } from '../http.ts'

type UpgradeRouteDeps = {
  openCase: (collectionFilename: string) => Promise<unknown>
  listCases: () => Promise<unknown>
  getCase: (id: number) => Promise<unknown>
  searchCase: (
    id: number,
    search: { artist?: string; title?: string; version?: string | null } | null | undefined
  ) => Promise<unknown>
  setReference: (
    id: number,
    input: { artist?: string; title?: string; version?: string | null; durationSeconds?: number | null }
  ) => Promise<unknown>
  getCandidates: (id: number) => Promise<unknown>
  getLocalCandidates: (id: number) => Promise<unknown>
  startDownloadPipeline: (
    id: number,
    username: string,
    filename: string,
    size: number
  ) => Promise<unknown>
  addLocalCandidate: (id: number, filename: string) => Promise<unknown>
  selectLocalCandidate: (id: number, filename: string) => Promise<unknown>
  replaceCase: (id: number) => Promise<unknown>
  markReanalyzed: (id: number) => Promise<unknown>
}

export function registerUpgradeRoutes(app: Express, deps: UpgradeRouteDeps): void {
  const {
    openCase,
    listCases,
    getCase,
    searchCase,
    setReference,
    getCandidates,
    getLocalCandidates,
    startDownloadPipeline,
    addLocalCandidate,
    selectLocalCandidate,
    replaceCase,
    markReanalyzed
  } = deps

  app.get('/api/upgrades', asyncHandler(async (_request, response) => {
    sendJson(response, 200, await listCases())
  }))

  app.post(
    '/api/upgrades',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { collectionFilename?: string } | null
      const collectionFilename =
        typeof body?.collectionFilename === 'string' ? body.collectionFilename.trim() : ''
      if (!collectionFilename) {
        throw new HttpError(400, 'collectionFilename is required.')
      }
      sendJson(response, 201, await openCase(collectionFilename))
    })
  )

  app.get('/api/upgrades/:id', asyncHandler(async (request, response) => {
    const item = await getCase(Number(request.params['id']))
    sendJson(response, item ? 200 : 404, item ?? { message: 'Upgrade case not found' })
  }))

  app.post(
    '/api/upgrades/:id/search',
    asyncHandler(async (request, response) => {
      const updated = await searchCase(
        Number(request.params['id']),
        ((request.body ?? null) as { artist?: string; title?: string; version?: string | null } | null) ??
          null
      )
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
    })
  )

  app.get('/api/upgrades/:id/candidates', asyncHandler(async (request, response) => {
    const id = Number(request.params['id'])
    const item = await getCase(id)
    sendJson(
      response,
      item ? 200 : 404,
      item ? await getCandidates(id) : { message: 'Upgrade case not found' }
    )
  }))

  app.post(
    '/api/upgrades/:id/reference',
    asyncHandler(async (request, response) => {
      const updated = await setReference(
        Number(request.params['id']),
        ((request.body ?? {}) as {
          artist?: string
          title?: string
          version?: string | null
          durationSeconds?: number | null
        })
      )
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
    })
  )

  app.get('/api/upgrades/:id/local-candidates', asyncHandler(async (request, response) => {
    const id = Number(request.params['id'])
    const item = await getCase(id)
    sendJson(
      response,
      item ? 200 : 404,
      item ? await getLocalCandidates(id) : { message: 'Upgrade case not found' }
    )
  }))

  app.post(
    '/api/upgrades/:id/download',
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
        throw new HttpError(400, 'Upgrade case id is invalid.')
      }
      if (!username || !filename || size <= 0) {
        throw new HttpError(400, 'username, filename, and size are required.')
      }
      const updated = await startDownloadPipeline(id, username, filename, size)
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
    })
  )

  app.post(
    '/api/upgrades/:id/local-candidates',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string } | null
      const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
      if (!filename) {
        throw new HttpError(400, 'filename is required.')
      }
      const updated = await addLocalCandidate(Number(request.params['id']), filename)
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
    })
  )

  app.post('/api/upgrades/:id/select-local', asyncHandler(async (request, response) => {
    const body = (request.body ?? null) as { filename?: string } | null
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
    if (!filename) {
      throw new HttpError(400, 'filename is required.')
    }
    const updated = await selectLocalCandidate(Number(request.params['id']), filename)
    sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
  }))

  app.post(
    '/api/upgrades/:id/replace',
    asyncHandler(async (request, response) => {
      const updated = await replaceCase(Number(request.params['id']))
      sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
    })
  )

  app.post('/api/upgrades/:id/reanalyze-complete', asyncHandler(async (request, response) => {
    const updated = await markReanalyzed(Number(request.params['id']))
    sendJson(response, updated ? 200 : 404, updated ?? { message: 'Upgrade case not found' })
  }))
}

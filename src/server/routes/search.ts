import type { Express } from 'express'
import type { AppSettings } from '../../backend/settings-store.ts'
import { GrokSearchService } from '../../backend/grok-search-service.ts'
import { OnlineSearchService } from '../../backend/online-search-service.ts'
import { YouTubeApiService } from '../../backend/youtube-api-service.ts'
import { HttpError, asyncHandler, readQueryString, sendJson } from '../http.ts'

type SlskdConnectionTestResult = {
  ok: boolean
  status: number | null
  endpoint: string | null
  message: string
}

type SearchRouteDeps = {
  currentSettings: () => AppSettings
  testSlskdConnection: (input: unknown) => Promise<SlskdConnectionTestResult>
  onlineSearchService: OnlineSearchService
  youtubeApiService: YouTubeApiService
  grokSearchService: GrokSearchService
}

export function registerSearchRoutes(app: Express, deps: SearchRouteDeps): void {
  const { currentSettings, testSlskdConnection, onlineSearchService, youtubeApiService, grokSearchService } =
    deps

  app.get('/api/settings', (_request, response) => {
    sendJson(response, 200, currentSettings())
  })

  app.post(
    '/api/slskd/test-connection',
    asyncHandler(async (request, response) => {
      sendJson(response, 200, await testSlskdConnection(request.body ?? null))
    })
  )

  app.get(
    '/api/online-search',
    asyncHandler(async (request, response) => {
      const query = readQueryString(request.query['query'])
      const scope = readQueryString(request.query['scope']) || 'online'
      sendJson(response, 200, await onlineSearchService.search(currentSettings(), query, scope))
    })
  )

  app.get(
    '/api/youtube-search',
    asyncHandler(async (request, response) => {
      const query = readQueryString(request.query['query'])
      sendJson(response, 200, await onlineSearchService.search(currentSettings(), query, 'youtube'))
    })
  )

  app.get(
    '/api/youtube-api/search',
    asyncHandler(async (request, response) => {
      const query = readQueryString(request.query['query'])
      sendJson(response, 200, await youtubeApiService.search(currentSettings(), query))
    })
  )

  app.get(
    '/api/discogs/:type/:id',
    asyncHandler(async (request, response) => {
      const type = request.params['type']
      const id = Number(request.params['id'])
      const isValidType =
        type === 'release' || type === 'artist' || type === 'label' || type === 'master'
      if (!isValidType || !Number.isFinite(id)) {
        throw new HttpError(404, 'Not found')
      }

      sendJson(response, 200, await onlineSearchService.getDiscogsEntity(currentSettings(), type, id))
    })
  )

  app.get(
    '/api/grok-search',
    asyncHandler(async (request, response) => {
      const query = readQueryString(request.query['query'])
      sendJson(response, 200, await grokSearchService.search(currentSettings(), query))
    })
  )
}

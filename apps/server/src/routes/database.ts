import type { Express } from 'express'
import type { DatabaseInspector } from '@djbrain/backend/database-inspector.ts'
import { asyncHandler, readQueryString, sendJson } from '../http.ts'

type DatabaseRouteDeps = {
  requireDatabaseInspector: () => DatabaseInspector
}

export function registerDatabaseRoutes(app: Express, deps: DatabaseRouteDeps): void {
  const service = deps.requireDatabaseInspector

  app.get('/api/database/tables', asyncHandler(async (_request, response) => {
    sendJson(response, 200, await service().listTables())
  }))

  app.get('/api/database/tables/:table/rows', asyncHandler(async (request, response) => {
    sendJson(
      response,
      200,
      await service().listRows(
        readParam(request.params.table),
        readQueryString(request.query['filter']),
        Number(request.query['limit'] ?? 50),
        Number(request.query['offset'] ?? 0)
      )
    )
  }))

  app.get('/api/database/tables/:table/rows/:key', asyncHandler(async (request, response) => {
    sendJson(response, 200, await service().getRow(readParam(request.params.table), readParam(request.params.key)))
  }))
}

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

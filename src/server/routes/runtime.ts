import type { Express } from 'express'
import type { RuntimeStatus } from '../../shared/runtime-status.ts'
import { asyncHandler, sendJson } from '../http.ts'

type RuntimeRouteDeps = {
  readStatus: () => Promise<RuntimeStatus>
}

export function registerRuntimeRoutes(app: Express, deps: RuntimeRouteDeps): void {
  app.get('/api/runtime/status', asyncHandler(async (_request, response) => {
    sendJson(response, 200, await deps.readStatus())
  }))
}

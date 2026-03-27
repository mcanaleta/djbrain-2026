import type { NextFunction, Request, Response } from 'express'

export class HttpError extends Error {
  public readonly status: number

  public readonly payload: unknown

  constructor(status: number, message: string, payload?: unknown) {
    super(message)
    this.status = status
    this.payload = payload ?? { message }
  }
}

export type RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction
) => Promise<void>

export function asyncHandler(handler: RequestHandler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next)
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected request error'
}

export function sendJson(response: Response, status: number, payload: unknown): void {
  response.status(status)
  response.set('Cache-Control', 'no-store')
  response.json(payload)
}

export function sendEmpty(response: Response, status: number): void {
  response.status(status).end()
}

export function readQueryString(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return readQueryString(value[0])
  }
  return ''
}

export function parseByteRange(
  rangeHeader: string,
  fileSize: number
): { start: number; end: number } | 'invalid' | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i)
  if (!match) {
    return null
  }

  const [, startRaw, endRaw] = match

  if (!startRaw && !endRaw) {
    return 'invalid'
  }

  if (!startRaw) {
    const suffixLength = parseInt(endRaw, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return 'invalid'
    }
    const length = Math.min(suffixLength, fileSize)
    return { start: Math.max(0, fileSize - length), end: fileSize - 1 }
  }

  const start = parseInt(startRaw, 10)
  if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
    return 'invalid'
  }

  const end = endRaw ? parseInt(endRaw, 10) : fileSize - 1
  if (!Number.isFinite(end) || end < start) {
    return 'invalid'
  }

  return { start, end: Math.min(end, fileSize - 1) }
}

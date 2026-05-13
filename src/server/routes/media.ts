import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Express } from 'express'
import { HttpError, asyncHandler, formatError, parseByteRange, readQueryString } from '../http.ts'

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus'
}

type MediaRouteDeps = {
  resolveMusicRelativePath: (filename: string) => string
}

export function registerMediaRoutes(app: Express, deps: MediaRouteDeps): void {
  const { resolveMusicRelativePath } = deps

  app.get(
    '/api/media',
    asyncHandler(async (request, response, next) => {
      const filename = readQueryString(request.query['filename'])
      if (!filename) {
        throw new HttpError(400, 'filename is required')
      }

      let filePath: string
      try {
        filePath = resolveMusicRelativePath(filename)
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, formatError(error))
      }

      let fileStats
      try {
        fileStats = await stat(filePath)
      } catch {
        throw new HttpError(404, 'File not found')
      }

      const fileSize = fileStats.size
      const contentType = AUDIO_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      const rangeHeader = request.get('range')

      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, fileSize)
        if (range === 'invalid') {
          response.status(416)
          response.set({
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${fileSize}`
          })
          response.end()
          return
        }

        if (range) {
          const { start, end } = range
          response.status(206)
          response.set({
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(end - start + 1)
          })
          const stream = createReadStream(filePath, { start, end })
          stream.on('error', next)
          stream.pipe(response)
          return
        }
      }

      response.status(200)
      response.set({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize)
      })
      const stream = createReadStream(filePath)
      stream.on('error', next)
      stream.pipe(response)
    })
  )
}

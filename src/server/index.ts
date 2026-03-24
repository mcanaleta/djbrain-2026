import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import express, { type NextFunction, type Request, type Response } from 'express'
import { readSettings, type AppSettings } from '../main/settings-store.ts'
import {
  CollectionService,
  type WantListAddInput,
  type WantListItem
} from '../main/collection-service.ts'
import { OnlineSearchService } from '../main/online-search-service.ts'
import { GrokSearchService } from '../main/grok-search-service.ts'
import { SlskdService } from '../main/slskd-service.ts'
import { DiscogsMatchService } from '../main/discogs-match-service.ts'
import { TaggerService } from '../main/tagger-service.ts'
import { AudioAnalysisService } from '../main/audio-analysis-service.ts'
import { ImportService, buildImportDestRelativePath, parseSongFilename } from '../main/import-service.ts'
import { YouTubeApiService } from '../main/youtube-api-service.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import type { ImportTagPreview, SlskdCandidate } from '../shared/api.ts'

const execFileAsync = promisify(execFile)

type SlskdConnectionTestInput = {
  baseURL: string
  apiKey: string
}

type SlskdConnectionTestResult = {
  ok: boolean
  status: number | null
  endpoint: string | null
  message: string
}

type RequestHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>

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

const EMPTY_DIR_IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

const port = Number(readArgValue('--port') ?? '5179')
const staticDirArg = readArgValue('--static')
const staticDir = staticDirArg ? resolve(process.cwd(), staticDirArg) : null
const dataDirArg = readArgValue('--data-dir') ?? process.env['DJBRAIN_DATA_DIR'] ?? null

const onlineSearchService = new OnlineSearchService()
const youtubeApiService = new YouTubeApiService()
const grokSearchService = new GrokSearchService()
const slskdService = new SlskdService()
const discogsMatchService = new DiscogsMatchService()
const taggerService = new TaggerService()
const audioAnalysisService = new AudioAnalysisService()
const importService = new ImportService(discogsMatchService, taggerService, onlineSearchService)

let collectionService: CollectionService | null = null
let settings: AppSettings | null = null

class HttpError extends Error {
  public readonly status: number

  public readonly payload: unknown

  constructor(status: number, message: string, payload?: unknown) {
    super(message)
    this.status = status
    this.payload = payload ?? { message }
  }
}

function readArgValue(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    return null
  }

  const value = process.argv[index + 1]
  return typeof value === 'string' && value.trim() ? value : null
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected request error'
}

function normalizeBaseURL(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim().replace(/\/+$/, '')
}

function normalizeApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeFilename(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function normalizeRelativeFolderPath(value: string): string {
  return normalizeFilename(value).replace(/\/+$/, '')
}

function normalizeSearchText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function strongSearchTerms(value: string | null | undefined): string[] {
  return normalizeSearchText(value).toLowerCase().split(' ').filter((term) => term.length > 1 && !/^\d+$/.test(term))
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && relativePath !== '..' && !relativePath.startsWith('/'))
  )
}

function sendJson(response: Response, status: number, payload: unknown): void {
  response.status(status)
  response.set('Cache-Control', 'no-store')
  response.json(payload)
}

function sendEmpty(response: Response, status: number): void {
  response.status(status).end()
}

function readQueryString(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return readQueryString(value[0])
  }
  return ''
}

function parseByteRange(
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

async function pruneEmptyDirectory(dir: string): Promise<number> {
  let removed = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      removed += await pruneEmptyDirectory(absolutePath)
      continue
    }

    if (entry.isFile() && EMPTY_DIR_IGNORED_FILES.has(entry.name)) {
      await unlink(absolutePath).catch(() => {})
    }
  }

  const remaining = await readdir(dir).catch(() => null)
  if (remaining !== null && remaining.length === 0) {
    await rmdir(dir).catch(() => {})
    removed += 1
  }

  return removed
}

async function clearEmptyDirsWithin(rootDir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    removed += await pruneEmptyDirectory(join(rootDir, entry.name))
  }

  return removed
}

async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath],
      { timeout: 8000 }
    )
    const data = JSON.parse(stdout) as { format?: { duration?: string } }
    const duration = parseFloat(data.format?.duration ?? '')
    return isFinite(duration) && duration > 0 ? duration : null
  } catch {
    return null
  }
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

async function resolveUserDataDir(): Promise<string> {
  return resolve(process.cwd(), dataDirArg || '.djbrain-data')
}

async function testSlskdConnection(input: unknown): Promise<SlskdConnectionTestResult> {
  const source =
    typeof input === 'object' && input !== null ? (input as Partial<SlskdConnectionTestInput>) : {}

  const baseURL = normalizeBaseURL(source.baseURL)
  const apiKey = normalizeApiKey(source.apiKey)

  if (!baseURL) {
    return { ok: false, status: null, endpoint: null, message: 'slskd Base URL is required.' }
  }
  if (!apiKey) {
    return { ok: false, status: null, endpoint: null, message: 'slskd API key is required.' }
  }

  let parsedBaseURL: URL
  try {
    parsedBaseURL = new URL(baseURL)
  } catch {
    return { ok: false, status: null, endpoint: null, message: 'slskd Base URL is invalid.' }
  }

  if (!['http:', 'https:'].includes(parsedBaseURL.protocol)) {
    return {
      ok: false,
      status: null,
      endpoint: null,
      message: 'slskd Base URL must use http or https.'
    }
  }

  const resolvedBaseURL = parsedBaseURL.toString().replace(/\/+$/, '')
  const candidatePaths = ['/api/v0/application', '/api/v0/session', '/api/v0/options']
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey
  }

  let lastFailure: SlskdConnectionTestResult = {
    ok: false,
    status: null,
    endpoint: null,
    message: 'Unable to reach slskd API.'
  }

  for (const path of candidatePaths) {
    const endpoint = `${resolvedBaseURL}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)

    try {
      const result = await fetch(endpoint, { method: 'GET', headers, signal: controller.signal })
      clearTimeout(timeout)

      if (result.ok) {
        return {
          ok: true,
          status: result.status,
          endpoint,
          message: `Connected to slskd (${result.status}).`
        }
      }

      if (result.status === 401 || result.status === 403) {
        return {
          ok: false,
          status: result.status,
          endpoint,
          message: 'Authentication failed. Verify slskd API key.'
        }
      }

      lastFailure = {
        ok: false,
        status: result.status,
        endpoint,
        message: `slskd responded with ${result.status} ${result.statusText}.`
      }
    } catch (error) {
      clearTimeout(timeout)
      const isTimeout = error instanceof Error && error.name === 'AbortError'
      lastFailure = {
        ok: false,
        status: null,
        endpoint,
        message: isTimeout ? 'Connection timed out.' : formatError(error)
      }
    }
  }

  return lastFailure
}

function currentSettings(): AppSettings {
  if (!settings) {
    throw new Error('Settings not initialized')
  }
  return settings
}

function resolveMusicRelativePath(filename: string): string {
  const relativeFilename = normalizeFilename(filename)
  const musicRoot = currentSettings().musicFolderPath.trim()
  if (!musicRoot) {
    throw new HttpError(400, 'Music root folder is not configured.')
  }

  const rootPath = resolve(musicRoot)
  const absolutePath = resolve(rootPath, relativeFilename)
  if (!isPathInside(rootPath, absolutePath)) {
    throw new HttpError(400, 'Requested file is outside the configured music root.')
  }

  return absolutePath
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function isDownloadFilename(filename: string): boolean {
  const normalized = normalizeFilename(filename)
  return currentSettings().downloadFolderPaths.some((folder) => {
    const prefix = normalizeRelativeFolderPath(folder)
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  })
}

function buildImportTagPreview(match: DiscogsTrackMatch): ImportTagPreview {
  return {
    artist: match.artist,
    title: match.title,
    album: match.releaseTitle,
    year: match.year,
    label: match.label,
    catalogNumber: match.catalogNumber,
    trackPosition: match.trackPosition,
    discogsReleaseId: match.releaseId,
    discogsTrackPosition: match.trackPosition
  }
}

function dedupeMatches(matches: DiscogsTrackMatch[]): DiscogsTrackMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    const key = [match.releaseId, match.trackPosition, match.artist, match.title, match.version].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readDiscogsTrackMatch(value: unknown): DiscogsTrackMatch | null {
  if (typeof value !== 'object' || value === null) return null
  const match = value as Partial<DiscogsTrackMatch>
  return (
    typeof match.releaseId === 'number' &&
    typeof match.releaseTitle === 'string' &&
    typeof match.artist === 'string' &&
    typeof match.title === 'string' &&
    (typeof match.version === 'string' || match.version === null || typeof match.version === 'undefined') &&
    (typeof match.trackPosition === 'string' || match.trackPosition === null || typeof match.trackPosition === 'undefined') &&
    (typeof match.year === 'string' || match.year === null || typeof match.year === 'undefined') &&
    (typeof match.label === 'string' || match.label === null || typeof match.label === 'undefined') &&
    (typeof match.catalogNumber === 'string' || match.catalogNumber === null || typeof match.catalogNumber === 'undefined') &&
    typeof match.score === 'number'
  )
    ? {
        releaseId: match.releaseId,
        releaseTitle: match.releaseTitle,
        artist: match.artist,
        title: match.title,
        version: match.version ?? null,
        trackPosition: match.trackPosition ?? null,
        year: match.year ?? null,
        label: match.label ?? null,
        catalogNumber: match.catalogNumber ?? null,
        score: match.score
      }
    : null
}

function readImportTagPreview(value: unknown): ImportTagPreview | null {
  if (typeof value !== 'object' || value === null) return null
  const tags = value as Partial<ImportTagPreview>
  const readText = (input: unknown): string | null =>
    typeof input === 'string' ? (input.trim() || null) : input === null || typeof input === 'undefined' ? null : null
  const readNumber = (input: unknown): number | null =>
    typeof input === 'number' && isFinite(input) ? input : input === null || typeof input === 'undefined' ? null : null
  return {
    artist: readText(tags.artist),
    title: readText(tags.title),
    album: readText(tags.album),
    year: readText(tags.year),
    label: readText(tags.label),
    catalogNumber: readText(tags.catalogNumber),
    trackPosition: readText(tags.trackPosition),
    discogsReleaseId: readNumber(tags.discogsReleaseId),
    discogsTrackPosition: readText(tags.discogsTrackPosition)
  }
}

function applyTagOverrides(match: DiscogsTrackMatch, tags: ImportTagPreview | null): DiscogsTrackMatch {
  if (!tags) return match
  return {
    ...match,
    releaseId: tags.discogsReleaseId ?? match.releaseId,
    releaseTitle: tags.album ?? match.releaseTitle,
    artist: tags.artist ?? match.artist,
    title: tags.title ?? match.title,
    trackPosition: tags.discogsTrackPosition ?? tags.trackPosition ?? match.trackPosition,
    year: tags.year ?? match.year,
    label: tags.label ?? match.label,
    catalogNumber: tags.catalogNumber ?? match.catalogNumber
  }
}

function isLikelySimilarTrack(
  filename: string,
  parsed: { artist: string; title: string; version: string | null }
): boolean {
  const normalized = normalizeSearchText(filename).toLowerCase()
  const artistTerms = strongSearchTerms(parsed.artist)
  const titleTerms = strongSearchTerms(parsed.title)
  const artistHit = artistTerms.length === 0 || artistTerms.some((term) => normalized.includes(term))
  const titleHit = titleTerms.length === 0 || titleTerms.some((term) => normalized.includes(term))
  return artistHit && titleHit
}

async function buildImportReview(filename: string) {
  const absolutePath = resolveMusicRelativePath(filename)
  const parsed = parseSongFilename(basename(absolutePath))
  if (!parsed) {
    throw new HttpError(400, `Cannot parse filename: ${basename(absolutePath)}`)
  }

  const settings = currentSettings()
  const { match, candidates } = await discogsMatchService.findTrack(
    settings,
    parsed.artist,
    parsed.title,
    parsed.version,
    onlineSearchService
  )
  const ext = extname(absolutePath).toLowerCase()
  const candidateMatches = dedupeMatches(match ? [match, ...candidates] : candidates).slice(0, 8)
  const reviewCandidates = await Promise.all(
    candidateMatches.map(async (candidate) => {
      const destinationRelativePath = buildImportDestRelativePath(settings.songsFolderPath, candidate, ext)
      return {
        match: candidate,
        proposedTags: buildImportTagPreview(candidate),
        destinationRelativePath,
        exactExistingFilename:
          (await fileExists(join(settings.musicFolderPath, destinationRelativePath))) ? destinationRelativePath : null
      }
    })
  )
  const query = `${parsed.artist} ${parsed.title} ${parsed.version ?? ''}`
  const similarItems = requireCollectionService()
    .list(query)
    .items
    .filter(
      (item) =>
        item.filename !== filename &&
        !isDownloadFilename(item.filename) &&
        isLikelySimilarTrack(item.filename, parsed)
    )
    .slice(0, 12)
    .map((item) => ({ ...item, duration: null }))

  return {
    filename,
    parsed,
    selectedCandidateIndex: reviewCandidates.length > 0 ? 0 : null,
    candidates: reviewCandidates,
    similarItems,
    sourceAnalysis: await audioAnalysisService.analyze(absolutePath).catch(() => null),
    tagWriteSupported: taggerService.supportsFile(absolutePath)
  }
}

async function showInFolder(filePath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', filePath])
    return
  }
  if (process.platform === 'win32') {
    await execFileAsync('explorer.exe', ['/select,', filePath])
    return
  }
  await execFileAsync('xdg-open', [dirname(filePath)])
}

async function openInSystemPlayer(filePath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [filePath])
    return
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', filePath])
    return
  }
  await execFileAsync('xdg-open', [filePath])
}

async function runSearchPipeline(item: WantListItem, queryOverride?: string): Promise<void> {
  const service = requireCollectionService()
  const settings = currentSettings()
  if (!settings.slskdBaseURL || !settings.slskdApiKey) {
    service.wantListUpdatePipeline(item.id, {
      pipelineStatus: 'error',
      pipelineError: 'slskd is not configured.'
    })
    return
  }

  const artist = item.artist.trim()
  const title = item.title.trim()
  const version = item.version?.trim() || null
  if (!artist || !title) {
    service.wantListUpdatePipeline(item.id, {
      pipelineStatus: 'error',
      pipelineError: 'Want list item is missing artist or title.'
    })
    return
  }

  try {
    const query =
      normalizeSearchText(queryOverride) || slskdService.buildSearchQuery(artist, title, version)
    const searchId = await slskdService.startSearch(settings, query)
    service.wantListUpdatePipeline(item.id, {
      pipelineStatus: 'searching',
      searchId,
      pipelineError: null
    })

    const search = await slskdService.waitForResults(settings, searchId)
    const candidates = slskdService.extractCandidates(artist, title, version, search)
    service.wantListUpdatePipeline(item.id, {
      pipelineStatus: candidates.length > 0 ? 'results_ready' : 'no_results',
      searchResultCount: candidates.length,
      bestCandidatesJson: candidates.length > 0 ? JSON.stringify(candidates) : null
    })
  } catch (error) {
    service.wantListUpdatePipeline(item.id, {
      pipelineStatus: 'error',
      pipelineError: error instanceof Error ? error.message : 'Search failed'
    })
  }
}

async function runImportPipeline(itemId: number, localFilePath: string): Promise<void> {
  const service = requireCollectionService()
  const settings = currentSettings()
  const item = service.wantListGet(itemId)
  if (!item) return

  if (!item.artist || !item.title || !item.year) {
    service.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'import_error',
      pipelineError: 'Artist, title, and year are required before importing. Fill them in and save.'
    })
    return
  }

  service.wantListUpdatePipeline(itemId, {
    pipelineStatus: 'identifying',
    pipelineError: null
  })

  try {
    const match = {
      releaseId: item.discogsReleaseId ?? 0,
      releaseTitle: item.album ?? item.title,
      artist: item.artist,
      title: item.title,
      version: item.version,
      trackPosition: item.discogsTrackPosition,
      year: item.year,
      label: item.label,
      catalogNumber: null,
      score: 100
    }

    const result = await importService.importFileWithKnownMatch(settings, match, localFilePath)

    if (result.status === 'imported' || result.status === 'imported_upgrade') {
      service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'imported',
        discogsReleaseId: result.match.releaseId,
        discogsTrackPosition: result.match.trackPosition,
        importedFilename: result.destRelativePath
      })
    } else if (result.status === 'skipped_existing') {
      service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'imported',
        discogsReleaseId: result.match.releaseId,
        discogsTrackPosition: result.match.trackPosition,
        importedFilename: result.existingRelativePath
      })
    } else {
      service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'import_error',
        pipelineError: result.status === 'error' ? result.message : 'Import failed'
      })
    }
  } catch (error) {
    service.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'import_error',
      pipelineError: error instanceof Error ? error.message : 'Import failed'
    })
  } finally {
    void service.syncNow()
  }
}

async function continueDownloadPipeline(
  itemId: number,
  username: string,
  filename: string
): Promise<void> {
  const service = requireCollectionService()
  const settings = currentSettings()

  try {
    const result = await slskdService.waitForDownload(settings, username, filename)

    if (result !== 'Completed') {
      console.warn(`[slskd] download did not complete: user=${username} file=${filename} result=${result}`)
      service.wantListUpdatePipeline(itemId, {
        pipelineStatus: 'error',
        pipelineError:
          result === 'Timeout' ? 'Download timed out' : 'Download failed or was cancelled'
      })
      return
    }

    service.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'downloaded'
    })

    const localPath = await importService.resolveLocalPath(settings, filename)
    if (localPath) {
      void runImportPipeline(itemId, localPath)
    }
  } catch (error) {
    console.error(
      `[slskd] download pipeline failed: user=${username} file=${filename}`,
      error
    )
    service.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'error',
      pipelineError: error instanceof Error ? error.message : 'Download failed'
    })
  }
}

async function startDownloadPipeline(
  itemId: number,
  username: string,
  filename: string,
  size: number
): Promise<WantListItem | null> {
  const service = requireCollectionService()
  const settings = currentSettings()
  const existing = service.wantListGet(itemId)

  if (!existing) {
    return null
  }

  await slskdService.downloadFile(settings, username, filename, size)

  const updated = service.wantListUpdatePipeline(itemId, {
    pipelineStatus: 'downloading',
    downloadUsername: username,
    downloadFilename: filename,
    pipelineError: null
  })

  void continueDownloadPipeline(itemId, username, filename)
  return updated
}

function asyncHandler(handler: RequestHandler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next)
  }
}

function createApp(): express.Express {
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

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

      sendJson(
        response,
        200,
        await onlineSearchService.getDiscogsEntity(currentSettings(), type, id)
      )
    })
  )

  app.get(
    '/api/grok-search',
    asyncHandler(async (request, response) => {
      const query = readQueryString(request.query['query'])
      sendJson(response, 200, await grokSearchService.search(currentSettings(), query))
    })
  )

  app.get('/api/collection', (request, response) => {
    const query = readQueryString(request.query['query'])
    sendJson(response, 200, requireCollectionService().list(query))
  })

  app.get(
    '/api/collection/downloads',
    asyncHandler(async (request, response) => {
      const service = requireCollectionService()
      const query = readQueryString(request.query['query'])
      const result = service.listDownloads(query)
      const musicFolderPath = currentSettings().musicFolderPath
      const items = await Promise.all(
        result.items.map(async (item) => {
          const absolutePath = join(musicFolderPath, item.filename)
          const duration = await getAudioDuration(absolutePath)
          return { ...item, duration }
        })
      )
      sendJson(response, 200, { items, total: result.total })
    })
  )

  app.get('/api/collection/status', (_request, response) => {
    sendJson(response, 200, requireCollectionService().getStatus())
  })

  app.post(
    '/api/collection/sync',
    asyncHandler(async (_request, response) => {
      sendJson(response, 200, await requireCollectionService().syncNow())
    })
  )

  app.post(
    '/api/collection/import/review',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string } | null
      const filename = typeof body?.filename === 'string' ? body.filename : ''
      sendJson(response, 200, await buildImportReview(filename))
    })
  )

  app.post(
    '/api/collection/import/compare',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string; existingFilename?: string } | null
      const filename = typeof body?.filename === 'string' ? body.filename : ''
      const existingFilename = typeof body?.existingFilename === 'string' ? body.existingFilename : ''
      const [sourceAnalysis, existingAnalysis] = await Promise.all([
        audioAnalysisService.analyze(resolveMusicRelativePath(filename)).catch(() => null),
        audioAnalysisService.analyze(resolveMusicRelativePath(existingFilename)).catch(() => null)
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
      if (replaceFilename) resolveMusicRelativePath(replaceFilename)

      const providedMatch = readDiscogsTrackMatch(body?.match)
      const tagOverrides = readImportTagPreview(body?.tags)
      const result = providedMatch
        ? await importService.importFileWithKnownMatch(settings, applyTagOverrides(providedMatch, tagOverrides), absolutePath, null, {
            conflictStrategy: body?.mode === 'replace_existing' ? 'replace' : 'keep_both',
            replaceRelativePath: replaceFilename
          })
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
      let removed = 0
      const settings = currentSettings()
      for (const folder of settings.downloadFolderPaths) {
        removed += await clearEmptyDirsWithin(
          join(settings.musicFolderPath, normalizeFilename(folder))
        )
      }
      void service.syncNow()
      sendJson(response, 200, { count: removed })
    })
  )

  app.post(
    '/api/collection/show-in-finder',
    asyncHandler(async (request, response) => {
      const body = (request.body ?? null) as { filename?: string } | null
      await showInFolder(
        resolveMusicRelativePath(typeof body?.filename === 'string' ? body.filename : '')
      )
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
      const item = requireCollectionService().wantListAdd(
        (request.body ?? null) as WantListAddInput
      )
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
    const candidates = parseStoredCandidates(item?.bestCandidatesJson ?? null)
    sendJson(response, 200, candidates)
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
    const updated = requireCollectionService().wantListUpdatePipeline(
      Number(request.params['id']),
      {
        pipelineStatus: 'idle',
        searchId: null,
        searchResultCount: 0,
        bestCandidatesJson: null,
        downloadUsername: null,
        downloadFilename: null,
        pipelineError: null
      }
    )
    sendJson(response, 200, updated)
  })

  if (staticDir) {
    app.use(express.static(staticDir))
    app.get(/^(?!\/api\/).*/, (_request, response) => {
      response.sendFile(resolve(staticDir, 'index.html'))
    })
  }

  app.use((_request, response) => {
    sendJson(response, 404, { message: 'Not found' })
  })

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next
    if (response.headersSent) {
      return
    }

    if (error instanceof SyntaxError && 'body' in error) {
      sendJson(response, 400, { message: 'Invalid JSON body' })
      return
    }

    if (error instanceof HttpError) {
      sendJson(response, error.status, error.payload)
      return
    }

    console.error('[server] request failed ', error)
    sendJson(response, 500, { message: formatError(error) })
  })

  return app
}

async function start(): Promise<void> {
  const userDataDir = await resolveUserDataDir()
  const dataDir = join(userDataDir, 'data')
  settings = readSettings()
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(join(userDataDir, 'cache'), { recursive: true }),
    mkdir(join(userDataDir, 'logs'), { recursive: true })
  ])

  collectionService = new CollectionService({
    databaseFilePath: join(dataDir, 'djbrain.sqlite')
  })
  await collectionService.reconfigure(currentSettings())
  void collectionService.syncNow()

  const app = createApp()
  const server = app.listen(port, () => {
    console.log(
      `[djbrain-server] listening on http://localhost:${port}${staticDir ? ` serving ${staticDir}` : ''}`
    )
    console.log(`[djbrain-server] using data dir ${userDataDir}`)
  })

  const shutdown = (): void => {
    server.close(() => {
      collectionService?.dispose()
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void start().catch((error) => {
  console.error('[server] failed to start', error)
  process.exit(1)
})
function requireCollectionService(): CollectionService {
  if (!collectionService) {
    throw new Error('Collection service not initialized')
  }
  return collectionService
}

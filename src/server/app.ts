import { execFile } from 'node:child_process'
import { mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import express, { type NextFunction, type Request, type Response } from 'express'
import { readSettings, type AppSettings } from '../backend/settings-store.ts'
import { CollectionService } from '../backend/collection-service.ts'
import { OnlineSearchService } from '../backend/online-search-service.ts'
import { GrokSearchService } from '../backend/grok-search-service.ts'
import { SlskdService } from '../backend/slskd-service.ts'
import { DiscogsMatchService } from '../backend/discogs-match-service.ts'
import { TaggerService } from '../backend/tagger-service.ts'
import { AudioAnalysisService } from '../backend/audio-analysis-service.ts'
import { FileAnalysisService } from '../backend/file-analysis-service.ts'
import { ImportService } from '../backend/import-service.ts'
import { ImportProcessingQueue } from '../backend/import-processing-queue.ts'
import { ImportReviewService } from '../backend/import-review-service.ts'
import { ImportReviewBackgroundService } from '../backend/import-review-background-service.ts'
import { IdentificationBackgroundService } from '../backend/identification-background-service.ts'
import { MusicBrainzService } from '../backend/musicbrainz-service.ts'
import { RecordingIdentityService } from '../backend/recording-identity-service.ts'
import { YouTubeApiService } from '../backend/youtube-api-service.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import type { ImportTagPreview } from '../shared/api.ts'
import { formatError, HttpError, sendJson } from './http.ts'
import { registerCollectionRoutes } from './routes/collection.ts'
import { registerMediaRoutes } from './routes/media.ts'
import { registerSearchRoutes } from './routes/search.ts'
import { registerUpgradeRoutes } from './routes/upgrades.ts'
import { registerWantListRoutes } from './routes/want-list.ts'
import { createCollectionActions, createUpgradeActions, createWantListPipelines } from './workflows.ts'

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

const EMPTY_DIR_IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

const port = Number(readArgValue('--port') ?? '5181')
const staticDirArg = readArgValue('--static')
const staticDir = staticDirArg ? resolve(process.cwd(), staticDirArg) : null
const dataDirArg = readArgValue('--data-dir') ?? process.env['DJBRAIN_DATA_DIR'] ?? null
const automationEnabled = readBooleanEnv(process.env['DJBRAIN_ENABLE_AUTOMATION'], !process.execArgv.includes('--watch'))

const onlineSearchService = new OnlineSearchService()
const youtubeApiService = new YouTubeApiService()
const grokSearchService = new GrokSearchService()
const slskdService = new SlskdService()
const discogsMatchService = new DiscogsMatchService()
const musicbrainzService = new MusicBrainzService()
const taggerService = new TaggerService()
const audioAnalysisService = new AudioAnalysisService()
const importProcessingQueue = new ImportProcessingQueue(process.env['DJBRAIN_REDIS_URL']?.trim() || null)
const identificationProcessingQueue = new ImportProcessingQueue(
  process.env['DJBRAIN_REDIS_URL']?.trim() || null,
  'djbrain:identification-processing'
)
const importService = new ImportService(discogsMatchService, taggerService, onlineSearchService)
const importReviewService = new ImportReviewService({
  getCollectionService: () => requireCollectionService(),
  resolveMusicRelativePath,
  getAudioDuration,
  isDownloadFilename,
  discogsMatchService,
  audioAnalysisService,
  taggerService,
  onlineSearchService
})
const fileAnalysisService = new FileAnalysisService({
  getCollectionService: () => requireCollectionService(),
  audioAnalysisService
})
const collectionActions = createCollectionActions({
  currentSettings,
  requireCollectionService,
  resolveMusicRelativePath,
  fileAnalysisService,
  importReviewService,
  importProcessingQueue
})
const wantListPipelines = createWantListPipelines({
  currentSettings,
  requireCollectionService,
  resolveMusicRelativePath,
  normalizeSearchText,
  slskdService,
  importService
})
const upgradeActions = createUpgradeActions({
  currentSettings,
  requireCollectionService,
  resolveMusicRelativePath,
  fileAnalysisService,
  getAudioDuration,
  normalizeSearchText,
  slskdService,
  importService,
  discogsMatchService,
  onlineSearchService
})

let collectionService: CollectionService | null = null
let recordingIdentityService: RecordingIdentityService | null = null
let importReviewBackgroundService: ImportReviewBackgroundService | null = null
let identificationBackgroundService: IdentificationBackgroundService | null = null
let settings: AppSettings | null = null

function readArgValue(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    return null
  }

  const value = process.argv[index + 1]
  return typeof value === 'string' && value.trim() ? value : null
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

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

function normalizeRelativeFolderPath(value: string): string {
  return normalizeFilename(value).replace(/\/+$/, '')
}

function normalizeSearchText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && relativePath !== '..' && !relativePath.startsWith('/'))
  )
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

async function resolveAppDataDir(): Promise<string> {
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

function isDownloadFilename(filename: string): boolean {
  const normalized = normalizeFilename(filename)
  return currentSettings().downloadFolderPaths.some((folder) => {
    const prefix = normalizeRelativeFolderPath(folder)
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  })
}

function readDiscogsTrackMatch(value: unknown): DiscogsTrackMatch | null {
  if (typeof value !== 'object' || value === null) return null
  const match = value as Partial<DiscogsTrackMatch>
  return (
    typeof match.releaseId === 'number' &&
    typeof match.releaseTitle === 'string' &&
    (typeof match.format === 'string' || match.format === null || typeof match.format === 'undefined') &&
    typeof match.artist === 'string' &&
    typeof match.title === 'string' &&
    (typeof match.version === 'string' || match.version === null || typeof match.version === 'undefined') &&
    (typeof match.trackPosition === 'string' || match.trackPosition === null || typeof match.trackPosition === 'undefined') &&
    (typeof match.year === 'string' || match.year === null || typeof match.year === 'undefined') &&
    (typeof match.label === 'string' || match.label === null || typeof match.label === 'undefined') &&
    (typeof match.catalogNumber === 'string' || match.catalogNumber === null || typeof match.catalogNumber === 'undefined') &&
    (typeof match.durationSeconds === 'number' || match.durationSeconds === null || typeof match.durationSeconds === 'undefined') &&
    typeof match.score === 'number'
  )
    ? {
        releaseId: match.releaseId,
        releaseTitle: match.releaseTitle,
        format: match.format ?? null,
        artist: match.artist,
        title: match.title,
        version: match.version ?? null,
        trackPosition: match.trackPosition ?? null,
        year: match.year ?? null,
        label: match.label ?? null,
        catalogNumber: match.catalogNumber ?? null,
        durationSeconds: match.durationSeconds ?? null,
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

const { buildImportReview, readCollectionStatus, showInFolder, openInSystemPlayer } = collectionActions
const { runSearchPipeline, runImportPipeline, startDownloadPipeline } = wantListPipelines
const {
  listCases,
  getCase,
  openCase,
  searchCase,
  setReference,
  getCandidates,
  getLocalCandidates,
  startDownloadPipeline: startUpgradeDownloadPipeline,
  addLocalCandidate,
  selectLocalCandidate,
  replaceCase,
  markReanalyzed
} = upgradeActions

export function createApp(): express.Express {
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  registerMediaRoutes(app, { resolveMusicRelativePath })

  registerSearchRoutes(app, {
    currentSettings,
    testSlskdConnection,
    onlineSearchService,
    youtubeApiService,
    grokSearchService
  })

  registerCollectionRoutes(app, {
    requireCollectionService,
    automationEnabled,
    currentSettings,
    readCollectionStatus: async () => ({ ...(await readCollectionStatus()), automationEnabled }),
    buildImportReview,
    fileAnalysisService,
    importService,
    syncImportReviewQueue: async () => {
      await importReviewBackgroundService?.syncQueue()
    },
    syncIdentificationQueue: async () => {
      await identificationBackgroundService?.syncQueue()
    },
    resolveMusicRelativePath,
    normalizeFilename,
    getAudioDuration,
    clearEmptyDirsWithin,
    showInFolder,
    openInSystemPlayer,
    readDiscogsTrackMatch,
    readImportTagPreview,
    applyTagOverrides
  })

  registerWantListRoutes(app, {
    requireCollectionService,
    normalizeSearchText,
    resolveMusicRelativePath,
    runSearchPipeline,
    runImportPipeline,
    startDownloadPipeline
  })

  registerUpgradeRoutes(app, {
    openCase,
    listCases,
    getCase,
    searchCase,
    setReference,
    getCandidates,
    getLocalCandidates,
    startDownloadPipeline: startUpgradeDownloadPipeline,
    addLocalCandidate,
    selectLocalCandidate,
    replaceCase,
    markReanalyzed
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

export async function start(): Promise<void> {
  const appDataDir = await resolveAppDataDir()
  const dataDir = join(appDataDir, 'data')
  settings = readSettings()
  await Promise.all([
    mkdir(appDataDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(join(appDataDir, 'cache'), { recursive: true }),
    mkdir(join(appDataDir, 'logs'), { recursive: true })
  ])
  await importProcessingQueue.start()
  await identificationProcessingQueue.start()

  collectionService = new CollectionService({
    connectionString: process.env['DJBRAIN_POSTGRES_URL']?.trim() || '',
    onImportQueueChanged: automationEnabled
      ? () => {
        void importReviewBackgroundService?.syncQueue()
      }
      : undefined,
    onIdentificationQueueChanged: automationEnabled
      ? () => {
        void identificationBackgroundService?.syncQueue()
      }
      : undefined
  })
  if (!process.env['DJBRAIN_POSTGRES_URL']?.trim()) {
    throw new Error('DJBRAIN_POSTGRES_URL is required. SQLite has been removed.')
  }
  await collectionService.reconfigure(currentSettings())
  recordingIdentityService = new RecordingIdentityService({
    collectionService,
    fileAnalysisService,
    taggerService,
    discogsMatchService,
    musicbrainzService,
    onlineSearchService,
    resolveMusicRelativePath,
    getSettings: currentSettings
  })
  importReviewBackgroundService = new ImportReviewBackgroundService({
    collectionService,
    fileAnalysisService,
    importReviewService,
    queue: importProcessingQueue,
    resolveMusicRelativePath,
    getSettings: currentSettings
  })
  identificationBackgroundService = new IdentificationBackgroundService({
    collectionService,
    identityService: recordingIdentityService,
    queue: identificationProcessingQueue
  })
  if (!automationEnabled) {
    await Promise.all([
      importProcessingQueue.clear(),
      identificationProcessingQueue.clear(),
      collectionService.resetImportReviewProcessing(),
      collectionService.resetIdentificationProcessing()
    ])
  } else {
    importReviewBackgroundService.start()
    identificationBackgroundService.start()
  }
  void collectionService.syncNow().then(async () => {
    if (!automationEnabled) return
    await Promise.all([
      importReviewBackgroundService?.syncQueue(),
      identificationBackgroundService?.syncQueue()
    ])
  })

  const app = createApp()
  const server = app.listen(port, () => {
    console.log(
      `[djbrain-server] listening on http://localhost:${port}${staticDir ? ` serving ${staticDir}` : ''}`
    )
    console.log(`[djbrain-server] using data dir ${appDataDir}`)
    console.log(`[djbrain-server] background automation ${automationEnabled ? 'enabled' : 'disabled'}`)
  })

  const shutdown = (): void => {
    server.close(() => {
      collectionService?.dispose()
      void importProcessingQueue.stop()
      void identificationProcessingQueue.stop()
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
function requireCollectionService(): CollectionService {
  if (!collectionService) {
    throw new Error('Collection service not initialized')
  }
  return collectionService
}

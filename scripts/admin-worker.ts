import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AudioAnalysisService } from '../src/backend/audio-analysis-service.ts'
import { CollectionService } from '../src/backend/collection-service.ts'
import { DiscogsMatchService } from '../src/backend/discogs-match-service.ts'
import { downloadDropboxFileToCache, readDropboxFileSourceConfig } from '../src/backend/dropbox-file-source.ts'
import { FileAnalysisService } from '../src/backend/file-analysis-service.ts'
import { IdentificationBackgroundService } from '../src/backend/identification-background-service.ts'
import { ImportProcessingQueue } from '../src/backend/import-processing-queue.ts'
import { ImportReviewBackgroundService } from '../src/backend/import-review-background-service.ts'
import { ImportReviewService } from '../src/backend/import-review-service.ts'
import { MusicBrainzService } from '../src/backend/musicbrainz-service.ts'
import { OnlineSearchService } from '../src/backend/online-search-service.ts'
import { processLeaseRetryMs, readProcessWorkerOptions } from '../src/backend/process-runtime.ts'
import { RecordingIdentityService } from '../src/backend/recording-identity-service.ts'
import { readSettings } from '../src/backend/settings-store.ts'
import { TaggerService } from '../src/backend/tagger-service.ts'

const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const normalizeFilename = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '')

async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath], { timeout: 8000 })
    const duration = parseFloat((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration ?? '')
    return isFinite(duration) && duration > 0 ? duration : null
  } catch {
    return null
  }
}

function requireConfig(): string {
  const dbUrl = process.env.DJBRAIN_POSTGRES_URL?.trim()
  if (!dbUrl) throw new Error('DJBRAIN_POSTGRES_URL is required.')
  return dbUrl
}

async function assertDirectory(path: string, label: string): Promise<void> {
  if (!path.trim()) throw new Error(`${label} is not configured.`)
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${label} is not an accessible directory: ${path}`)
}

async function main(): Promise<void> {
  const settings = readSettings()
  const dropboxConfig = readDropboxFileSourceConfig(settings)
  const dropboxCacheRoot = resolve(process.env.DJBRAIN_DATA_DIR ?? '.djbrain-data', 'dropbox-cache')
  const options = readProcessWorkerOptions({
    args: process.argv.slice(2),
    env: process.env,
    hostname: hostname(),
    pid: process.pid,
    defaultIntervalSeconds: 30,
    defaultLimit: 4,
    defaultLeaseSeconds: 300
  })
  const collectionService = new CollectionService({ connectionString: requireConfig(), watchFileSystem: false })
  if (!dropboxConfig) {
    await assertDirectory(settings.musicFolderPath, 'Music root')
    await assertDirectory(resolve(settings.musicFolderPath, settings.songsFolderPath), 'Songs folder')
  }
  const audioAnalysisService = new AudioAnalysisService()
  const fileAnalysisService = new FileAnalysisService({ getCollectionService: () => collectionService, audioAnalysisService })
  const taggerService = new TaggerService()
  const onlineSearchService = new OnlineSearchService()
  const discogsMatchService = new DiscogsMatchService()
  const resolveMusicRelativePath = async (filename: string): Promise<string> => {
    if (dropboxConfig) {
      const snapshot = await collectionService.readFileSnapshot(filename)
      return downloadDropboxFileToCache(dropboxConfig, filename, dropboxCacheRoot, snapshot?.filesize ?? null)
    }
    const root = resolve(settings.musicFolderPath)
    const absolute = resolve(root, normalizeFilename(filename))
    const rel = relative(root, absolute)
    if (!settings.musicFolderPath || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('File is outside music root.')
    return absolute
  }
  const isDownloadFilename = (filename: string): boolean =>
    settings.downloadFolderPaths.some((folder) => {
      const prefix = normalizeFilename(folder)
      const normalized = normalizeFilename(filename)
      return normalized === prefix || normalized.startsWith(`${prefix}/`)
    })
  const importQueue = new ImportProcessingQueue(process.env.DJBRAIN_REDIS_URL?.trim() || null)
  const identifyQueue = new ImportProcessingQueue(process.env.DJBRAIN_REDIS_URL?.trim() || null, 'djbrain:identification-processing')
  const importReview = new ImportReviewBackgroundService({
    collectionService,
    fileAnalysisService,
    importReviewService: new ImportReviewService({
      getCollectionService: () => collectionService,
      resolveMusicRelativePath,
      getAudioDuration,
      isDownloadFilename,
      discogsMatchService,
      audioAnalysisService,
      taggerService,
      onlineSearchService
    }),
    queue: importQueue,
    resolveMusicRelativePath,
    getSettings: () => settings
  })
  const identification = new IdentificationBackgroundService({
    collectionService,
    queue: identifyQueue,
    identityService: new RecordingIdentityService({
      collectionService,
      fileAnalysisService,
      taggerService,
      discogsMatchService,
      musicbrainzService: new MusicBrainzService(),
      onlineSearchService,
      resolveMusicRelativePath,
      getSettings: () => settings
    })
  })
  let stopped = false
  let prepared = false
  process.on('SIGINT', () => { stopped = true })
  process.on('SIGTERM', () => { stopped = true })
  await Promise.all([importQueue.start(), identifyQueue.start(), collectionService.reconfigure(settings)])
  try {
    while (!stopped) {
      const lease = await collectionService.acquireProcessLease({
        role: 'admin',
        ownerId: options.ownerId,
        hostname: hostname(),
        pid: process.pid,
        priority: options.priority,
        takeover: options.takeover,
        leaseMs: options.leaseMs,
        takeoverReason: options.takeover ? 'explicit takeover' : null
      })
      if (!lease) {
        console.log(`[admin] lease held by another owner; owner=${options.ownerId} priority=${options.priority}`)
        await sleep(processLeaseRetryMs(options.intervalSeconds))
        continue
      }
      if (options.dryRun) {
        console.log('[admin] dry-run tick')
      } else {
        if (!prepared) {
          await collectionService.resetImportReviewProcessing()
          await collectionService.resetIdentificationProcessing()
          await collectionService.queueIdentificationFiles([], false)
          prepared = true
        }
        const importQueued = await importReview.syncQueue(false)
        const identifyQueued = await identification.syncQueue(false)
        const importDone = await importReview.processAvailable(options.limit, false)
        const identifyDone = await identification.processAvailable(options.limit, false)
        console.log(`[admin] import queued=${importQueued} processed=${importDone}; identify queued=${identifyQueued} processed=${identifyDone}`)
      }
      if (!(await collectionService.touchProcessLease('admin', options.ownerId, options.leaseMs))) console.log('[admin] lease lost')
      await sleep(options.intervalSeconds * 1_000)
    }
  } finally {
    await collectionService.releaseProcessLease('admin', options.ownerId).catch(() => undefined)
    await Promise.all([importQueue.stop(), identifyQueue.stop()])
    collectionService.dispose()
  }
}

main().catch((error) => {
  console.error('[admin] fatal:', error)
  process.exitCode = 1
})

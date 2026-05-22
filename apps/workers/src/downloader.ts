import { hostname } from 'node:os'
import { CollectionService, type DownloadAttempt, type WantListItem } from '@djbrain/backend/collection-service.ts'
import { processLeaseRetryMs, readProcessWorkerOptions, type ProcessWorkerOptions } from '@djbrain/backend/process-runtime.ts'
import { readSettings, type AppSettings } from '@djbrain/backend/settings-store.ts'
import { SlskdService, type SlskdCandidate } from '@djbrain/backend/slskd-service.ts'
import { buildDownloadRequests, buildExpectedDownloadFilename, downloadAttemptStatusFromSlskdState, wantListStatusAfterAttempt } from '@djbrain/backend/downloader-worker-planning.ts'
import { parseDurationString } from '@djbrain/shared/track-matcher.ts'

type Options = ProcessWorkerOptions

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function readOptions(): Options {
  return readProcessWorkerOptions({
    args: process.argv.slice(2),
    env: process.env,
    hostname: hostname(),
    pid: process.pid,
    defaultIntervalSeconds: 60,
    defaultLimit: 10
  })
}

function requireConfig(settings: AppSettings): string {
  const dbUrl = process.env.DJBRAIN_POSTGRES_URL?.trim()
  if (!dbUrl) throw new Error('DJBRAIN_POSTGRES_URL is required.')
  if (!settings.slskdBaseURL || !settings.slskdApiKey) throw new Error('DJBRAIN_SLSKD_BASE_URL and DJBRAIN_SLSKD_API_KEY are required.')
  return dbUrl
}

function nextSearchAt(candidateCount: number): string {
  return new Date(Date.now() + (candidateCount > 0 ? 60 : 360) * 60_000).toISOString()
}

async function monitorAttempt(
  settings: AppSettings,
  service: CollectionService,
  slskd: SlskdService,
  attempt: DownloadAttempt,
  dryRun: boolean
): Promise<void> {
  if (!attempt.username || !attempt.remoteFilename || attempt.remoteSize == null) return
  if (attempt.status === 'queued') {
    console.log(`[downloader] request ${attempt.id}: ${attempt.username} ${attempt.remoteFilename}`)
    if (dryRun) return
    try {
      await slskd.downloadFile(settings, attempt.username, attempt.remoteFilename, attempt.remoteSize)
      await service.downloadAttemptUpdate(attempt.id, { status: 'requested', requestedAt: new Date().toISOString(), errorMessage: null })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Download request failed'
      await service.downloadAttemptUpdate(attempt.id, { status: 'failed', errorMessage })
      if (attempt.wantListId) await service.wantListUpdatePipeline(attempt.wantListId, { pipelineStatus: 'error', pipelineError: errorMessage })
    }
    return
  }

  const state = await slskd.getDownloadState(settings, attempt.username, attempt.remoteFilename)
  const status = downloadAttemptStatusFromSlskdState(state)
  if (!status || dryRun) return
  const errorMessage = ['failed', 'timeout', 'cancelled'].includes(status) ? `slskd transfer ${state ?? status}` : null
  await service.downloadAttemptUpdate(attempt.id, {
    status,
    expectedLocalFilename: attempt.expectedLocalFilename ?? buildExpectedDownloadFilename(settings.downloadFolderPaths, attempt.remoteFilename),
    completedAt: status === 'downloaded' ? new Date().toISOString() : attempt.completedAt,
    errorMessage
  })
  if (attempt.wantListId) {
    const attempts = await service.downloadAttemptListForWantList(attempt.wantListId)
    const patch = wantListStatusAfterAttempt(status, attempts.some((item) => item.status === 'downloaded'), errorMessage)
    if (patch) await service.wantListUpdatePipeline(attempt.wantListId, patch)
  }
}

async function searchWant(
  settings: AppSettings,
  service: CollectionService,
  slskd: SlskdService,
  want: WantListItem,
  dryRun: boolean
): Promise<void> {
  const query = slskd.buildSearchQuery(want.artist, want.title, want.version)
  console.log(`[downloader] search want ${want.id}: ${query}`)
  if (dryRun) return

  await service.wantListUpdatePipeline(want.id, { pipelineStatus: 'searching', lastSearchAt: new Date().toISOString(), pipelineError: null })
  try {
    const searchId = await slskd.startSearch(settings, query)
    await service.wantListUpdatePipeline(want.id, { searchId })
    const candidates = slskd.extractCandidates(want.artist, want.title, want.version, await slskd.waitForResults(settings, searchId), want.length ? parseDurationString(want.length) : null)
    const attempts = await service.downloadAttemptListForWantList(want.id)
    const plans = buildDownloadRequests({
      wantListId: want.id,
      query,
      searchId,
      targetDownloadCount: want.targetDownloadCount,
      downloadFolderPaths: settings.downloadFolderPaths,
      candidates: candidates as SlskdCandidate[],
      existingAttempts: attempts
    })
    await service.wantListUpdatePipeline(want.id, {
      pipelineStatus: plans.length ? 'downloading' : candidates.length ? 'results_ready' : 'no_results',
      searchResultCount: candidates.length,
      bestCandidatesJson: candidates.length ? JSON.stringify(candidates) : null,
      nextSearchAt: nextSearchAt(candidates.length)
    })

    for (const plan of plans) {
      const attempt = await service.downloadAttemptCreate({
        wantListId: want.id,
        status: 'queued',
        originRecordingId: want.recordingId,
        originArtist: want.artist,
        originTitle: want.title,
        originVersion: want.version,
        originYear: want.year,
        originAlbum: want.album,
        originLabel: want.label,
        originSourceCollectionFilename: want.sourceCollectionFilename,
        originDiscogsReleaseId: want.discogsReleaseId,
        originDiscogsTrackPosition: want.discogsTrackPosition,
        searchQuery: plan.query,
        slskdSearchId: plan.searchId,
        username: plan.username,
        remoteFilename: plan.remoteFilename,
        remoteSize: plan.remoteSize,
        bitrate: plan.bitrate,
        durationSeconds: plan.durationSeconds,
        extension: plan.extension,
        score: plan.score,
        queueLength: plan.queueLength,
        hasFreeUploadSlot: plan.hasFreeUploadSlot,
        uploadSpeed: plan.uploadSpeed,
        isLocked: plan.isLocked,
        expectedLocalFilename: plan.expectedLocalFilename,
        rawCandidateJson: plan.rawCandidateJson
      })
      await monitorAttempt(settings, service, slskd, attempt, false)
    }
  } catch (error) {
    await service.wantListUpdatePipeline(want.id, {
      pipelineStatus: 'error',
      pipelineError: error instanceof Error ? error.message : 'Search failed',
      nextSearchAt: nextSearchAt(0)
    })
  }
}

async function tick(settings: AppSettings, service: CollectionService, slskd: SlskdService, options: Options): Promise<void> {
  const active = await service.downloadAttemptListActive(options.limit)
  console.log(`[downloader] active=${active.length} dryRun=${options.dryRun}`)
  for (const attempt of active) await monitorAttempt(settings, service, slskd, attempt, options.dryRun)

  const wants = await service.wantListListDueForDownload(options.limit)
  console.log(`[downloader] due=${wants.length}`)
  for (const want of wants) await searchWant(settings, service, slskd, want, options.dryRun)
}

async function main(): Promise<void> {
  const settings = readSettings()
  const options = readOptions()
  const service = new CollectionService({ connectionString: requireConfig(settings), debounceMs: 1_000, watchFileSystem: false })
  const slskd = new SlskdService()
  let stopped = false
  process.on('SIGINT', () => { stopped = true })
  process.on('SIGTERM', () => { stopped = true })
  try {
    while (!stopped) {
      const lease = await service.acquireProcessLease({
        role: 'downloader',
        ownerId: options.ownerId,
        hostname: hostname(),
        pid: process.pid,
        priority: options.priority,
        takeover: options.takeover,
        leaseMs: options.leaseMs,
        takeoverReason: options.takeover ? 'explicit takeover' : null
      })
      if (!lease) {
        console.log(`[downloader] lease held by another owner; owner=${options.ownerId} priority=${options.priority}`)
        await sleep(processLeaseRetryMs(options.intervalSeconds))
        continue
      }
      const result = await service.withDownloaderLock(() => tick(settings, service, slskd, options))
      if (result === null) console.log('[downloader] another worker holds the lock')
      if (!(await service.touchProcessLease('downloader', options.ownerId, options.leaseMs))) {
        console.log('[downloader] lease lost')
      }
      await sleep(options.intervalSeconds * 1_000)
    }
  } finally {
    await service.releaseProcessLease('downloader', options.ownerId).catch(() => undefined)
    service.dispose()
  }
}

main().catch((error) => {
  console.error('[downloader] fatal:', error)
  process.exitCode = 1
})

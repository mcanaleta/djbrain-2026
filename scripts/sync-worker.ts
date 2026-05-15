import { hostname } from 'node:os'
import { CollectionService } from '../src/backend/collection-service.ts'
import { readProcessWorkerOptions } from '../src/backend/process-runtime.ts'
import { readSettings } from '../src/backend/settings-store.ts'

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function requireConfig(): string {
  const dbUrl = process.env.DJBRAIN_POSTGRES_URL?.trim()
  if (!dbUrl) throw new Error('DJBRAIN_POSTGRES_URL is required.')
  return dbUrl
}

async function main(): Promise<void> {
  const options = readProcessWorkerOptions({
    args: process.argv.slice(2),
    env: process.env,
    hostname: hostname(),
    pid: process.pid,
    defaultIntervalSeconds: 300,
    defaultLimit: 1
  })
  const service = new CollectionService({ connectionString: requireConfig(), watchFileSystem: false })
  let stopped = false
  process.on('SIGINT', () => { stopped = true })
  process.on('SIGTERM', () => { stopped = true })
  try {
    await service.reconfigure(readSettings())
    while (!stopped) {
      const lease = await service.acquireProcessLease({
        role: 'sync',
        ownerId: options.ownerId,
        hostname: hostname(),
        pid: process.pid,
        priority: options.priority,
        takeover: options.takeover,
        leaseMs: options.leaseMs,
        takeoverReason: options.takeover ? 'explicit takeover' : null
      })
      if (!lease) {
        console.log(`[sync] lease held by another owner; owner=${options.ownerId} priority=${options.priority}`)
        await sleep(options.intervalSeconds * 1_000)
        continue
      }
      if (options.dryRun) {
        console.log('[sync] dry-run tick')
      } else {
        const status = await service.syncNow()
        console.log(`[sync] rows=${status.itemCount} error=${status.lastError ?? 'none'}`)
      }
      if (!(await service.touchProcessLease('sync', options.ownerId, options.leaseMs))) console.log('[sync] lease lost')
      await sleep(options.intervalSeconds * 1_000)
    }
  } finally {
    await service.releaseProcessLease('sync', options.ownerId).catch(() => undefined)
    service.dispose()
  }
}

main().catch((error) => {
  console.error('[sync] fatal:', error)
  process.exitCode = 1
})

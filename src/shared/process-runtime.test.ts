import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  processLeaseRetryMs,
  readProcessWorkerOptions,
  shouldRunServerBackgroundWorkers,
  shouldRunServerStartupSync
} from '../backend/process-runtime.ts'

describe('readProcessWorkerOptions', () => {
  it('reads shared takeover and lease flags for a daemon worker', () => {
    const options = readProcessWorkerOptions({
      args: ['--interval-seconds', '15', '--limit', '4', '--owner-id', 'machook', '--priority', '50', '--takeover', '--lease-seconds', '20'],
      env: {},
      hostname: 'host',
      pid: 123,
      defaultIntervalSeconds: 300,
      defaultLimit: 10
    })

    assert.deepEqual(options, {
      intervalSeconds: 15,
      limit: 4,
      dryRun: false,
      ownerId: 'machook',
      priority: 50,
      takeover: true,
      leaseMs: 20_000
    })
  })

  it('uses process owner env and clamps unsafe numeric options', () => {
    const options = readProcessWorkerOptions({
      args: ['--interval-seconds', '1', '--limit', '0', '--priority', '-1', '--lease-seconds', '2', '--dry-run'],
      env: { DJBRAIN_PROCESS_OWNER_ID: 'prod', DJBRAIN_PROCESS_TAKEOVER: '1' },
      hostname: 'host',
      pid: 123,
      defaultIntervalSeconds: 60,
      defaultLimit: 10
    })

    assert.equal(options.intervalSeconds, 5)
    assert.equal(options.limit, 1)
    assert.equal(options.ownerId, 'prod')
    assert.equal(options.priority, 0)
    assert.equal(options.takeover, true)
    assert.equal(options.leaseMs, 10_000)
    assert.equal(options.dryRun, true)
  })

  it('keeps the lease alive longer than the polling interval', () => {
    const options = readProcessWorkerOptions({
      args: ['--interval-seconds', '300'],
      env: {},
      hostname: 'host',
      pid: 123,
      defaultIntervalSeconds: 60,
      defaultLimit: 10
    })

    assert.equal(options.leaseMs, 305_000)
  })

  it('supports longer default leases for slow file workers', () => {
    const options = readProcessWorkerOptions({
      args: ['--interval-seconds', '30'],
      env: {},
      hostname: 'host',
      pid: 123,
      defaultIntervalSeconds: 60,
      defaultLimit: 10,
      defaultLeaseSeconds: 300
    })

    assert.equal(options.leaseMs, 300_000)
  })
})

describe('processLeaseRetryMs', () => {
  it('retries denied leases quickly without busy looping', () => {
    assert.equal(processLeaseRetryMs(300), 30_000)
    assert.equal(processLeaseRetryMs(10), 10_000)
    assert.equal(processLeaseRetryMs(1), 5_000)
  })
})

describe('shouldRunServerStartupSync', () => {
  it('keeps server startup sync disabled unless explicitly enabled', () => {
    assert.equal(shouldRunServerStartupSync({}), false)
    assert.equal(shouldRunServerStartupSync({ DJBRAIN_ENABLE_SERVER_SYNC: '1' }), true)
    assert.equal(shouldRunServerStartupSync({ DJBRAIN_ENABLE_SERVER_SYNC: 'false' }), false)
  })
})

describe('shouldRunServerBackgroundWorkers', () => {
  it('keeps queue processors out of the HTTP server unless explicitly enabled', () => {
    assert.equal(shouldRunServerBackgroundWorkers({}), false)
    assert.equal(shouldRunServerBackgroundWorkers({ DJBRAIN_ENABLE_SERVER_WORKERS: '1' }), true)
    assert.equal(shouldRunServerBackgroundWorkers({ DJBRAIN_ENABLE_SERVER_WORKERS: 'false' }), false)
  })
})

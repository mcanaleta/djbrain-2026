import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRuntimeProcessStatuses, takeoverCommand } from './runtime-status.ts'

describe('buildRuntimeProcessStatuses', () => {
  const nowMs = Date.parse('2026-05-15T10:00:00Z')

  it('shows active, stale, and missing daemon leases', () => {
    const rows = buildRuntimeProcessStatuses([
      {
        role: 'downloader',
        ownerId: 'prod',
        hostname: 'raspberry4',
        pid: 12,
        priority: 10,
        codeVersion: 'schema-1',
        schemaVersion: 1,
        heartbeatAt: '2026-05-15T09:59:55.000Z',
        leaseExpiresAt: '2026-05-15T10:01:00.000Z'
      },
      {
        role: 'sync',
        ownerId: 'old',
        hostname: null,
        pid: null,
        priority: 10,
        codeVersion: 'schema-1',
        schemaVersion: 1,
        heartbeatAt: '2026-05-15T09:50:00.000Z',
        leaseExpiresAt: '2026-05-15T09:55:00.000Z'
      }
    ], nowMs, 'machook', 50)

    assert.equal(rows.find((row) => row.role === 'downloader')?.state, 'active')
    assert.equal(rows.find((row) => row.role === 'sync')?.state, 'stale')
    assert.equal(rows.find((row) => row.role === 'admin')?.state, 'missing')
    assert.equal(rows.find((row) => row.role === 'downloader')?.secondsUntilExpiry, 60)
  })
})

describe('takeoverCommand', () => {
  it('builds the explicit local takeover command for daemon roles', () => {
    assert.equal(
      takeoverCommand('sync', 'machook', 50),
      'pnpm run sync -- --owner-id machook --priority 50 --takeover'
    )
  })
})

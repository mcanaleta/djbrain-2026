import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APP_SCHEMA_VERSION,
  decideProcessLease,
  ensureAppSchemaVersion,
  validateSchemaVersion
} from '../backend/runtime-governance.ts'

describe('validateSchemaVersion', () => {
  it('refuses old code against a newer database', () => {
    assert.throws(
      () => validateSchemaVersion(APP_SCHEMA_VERSION + 1, APP_SCHEMA_VERSION),
      /newer than this code/
    )
  })

  it('allows first boot and older databases to be upgraded by current code', () => {
    assert.equal(validateSchemaVersion(null, APP_SCHEMA_VERSION).action, 'initialize')
    assert.equal(validateSchemaVersion(APP_SCHEMA_VERSION - 1, APP_SCHEMA_VERSION).action, 'upgrade')
    assert.equal(validateSchemaVersion(APP_SCHEMA_VERSION, APP_SCHEMA_VERSION).action, 'ok')
  })
})

describe('ensureAppSchemaVersion', () => {
  it('checks newer databases in read-only mode without creating schema state', async () => {
    const queries: string[] = []
    const db = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        queries.push(sql)
        if (sql.includes('to_regclass')) return { rows: [{ state: 'app_schema_state' } as unknown as T] }
        if (sql.includes('SELECT schema_version')) return { rows: [{ schema_version: APP_SCHEMA_VERSION + 1 } as unknown as T] }
        return { rows: [] }
      }
    }

    await assert.rejects(() => ensureAppSchemaVersion(db, false), /newer than this code/)
    assert.equal(queries.some((sql) => sql.includes('CREATE TABLE')), false)
  })
})

describe('decideProcessLease', () => {
  const nowMs = Date.parse('2026-05-15T10:00:00Z')
  const liveLease = {
    role: 'downloader',
    ownerId: 'prod',
    priority: 10,
    leaseExpiresAtMs: nowMs + 10_000
  }

  it('allows same owner renewal and stale lease replacement', () => {
    assert.equal(decideProcessLease(liveLease, { ownerId: 'prod', priority: 10, takeover: false, nowMs }).action, 'acquire')
    assert.equal(
      decideProcessLease({ ...liveLease, leaseExpiresAtMs: nowMs - 1 }, { ownerId: 'local', priority: 10, takeover: false, nowMs }).action,
      'acquire'
    )
  })

  it('requires explicit takeover and higher priority to preempt a live owner', () => {
    assert.equal(decideProcessLease(liveLease, { ownerId: 'local', priority: 50, takeover: false, nowMs }).action, 'deny')
    assert.equal(decideProcessLease(liveLease, { ownerId: 'local', priority: 5, takeover: true, nowMs }).action, 'deny')
    assert.equal(decideProcessLease(liveLease, { ownerId: 'local', priority: 50, takeover: true, nowMs }).action, 'acquire')
  })
})

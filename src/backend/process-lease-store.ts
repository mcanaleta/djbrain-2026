import type { Pool } from 'pg'
import { toNumber } from './collection-service-helpers.ts'
import { APP_SCHEMA_VERSION, decideProcessLease, type ProcessLeaseSnapshot } from './runtime-governance.ts'

export const PROCESS_LEASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS process_leases (
    role TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    hostname TEXT,
    pid INTEGER,
    priority INTEGER NOT NULL,
    code_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    takeover_reason TEXT
  );
`

export type ProcessLease = ProcessLeaseSnapshot & {
  hostname: string | null
  pid: number | null
  codeVersion: string
  schemaVersion: number
  heartbeatAt: string
  leaseExpiresAt: string
}

export type ProcessLeaseInput = {
  role: string
  ownerId: string
  hostname?: string | null
  pid?: number | null
  priority: number
  takeover: boolean
  leaseMs: number
  takeoverReason?: string | null
}

type LeaseRow = {
  role: string
  ownerid: string
  hostname: string | null
  pid: number | string | null
  priority: number | string
  codeversion: string
  schemaversion: number | string
  heartbeatat: Date | string
  leaseexpiresat: Date | string
}

const toIso = (value: Date | string): string => value instanceof Date ? value.toISOString() : String(value)

export class ProcessLeaseStore {
  constructor(private readonly pool: Pool) {}

  private row(row: LeaseRow): ProcessLease {
    const leaseExpiresAt = toIso(row.leaseexpiresat)
    return {
      role: row.role,
      ownerId: row.ownerid,
      hostname: row.hostname,
      pid: row.pid == null ? null : toNumber(row.pid),
      priority: toNumber(row.priority),
      codeVersion: row.codeversion,
      schemaVersion: toNumber(row.schemaversion),
      heartbeatAt: toIso(row.heartbeatat),
      leaseExpiresAt,
      leaseExpiresAtMs: Date.parse(leaseExpiresAt)
    }
  }

  public async acquire(input: ProcessLeaseInput): Promise<ProcessLease | null> {
    const client = await this.pool.connect()
    const now = new Date()
    const expires = new Date(now.getTime() + input.leaseMs)
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`process:${input.role}`])
      const currentRow = (await client.query<LeaseRow>(
        `
          SELECT role, owner_id AS ownerid, hostname, pid, priority, code_version AS codeversion,
            schema_version AS schemaversion, heartbeat_at AS heartbeatat, lease_expires_at AS leaseexpiresat
          FROM process_leases
          WHERE role = $1
        `,
        [input.role]
      )).rows[0]
      const current = currentRow ? this.row(currentRow) : null
      const decision = decideProcessLease(current, {
        ownerId: input.ownerId,
        priority: input.priority,
        takeover: input.takeover,
        nowMs: now.getTime()
      })
      if (decision.action === 'deny') {
        await client.query('COMMIT')
        return null
      }
      const row = (await client.query<LeaseRow>(
        `
          INSERT INTO process_leases(
            role, owner_id, hostname, pid, priority, code_version, schema_version,
            heartbeat_at, lease_expires_at, takeover_reason
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(role) DO UPDATE SET
            owner_id = excluded.owner_id,
            hostname = excluded.hostname,
            pid = excluded.pid,
            priority = excluded.priority,
            code_version = excluded.code_version,
            schema_version = excluded.schema_version,
            heartbeat_at = excluded.heartbeat_at,
            lease_expires_at = excluded.lease_expires_at,
            takeover_reason = excluded.takeover_reason
          RETURNING role, owner_id AS ownerid, hostname, pid, priority, code_version AS codeversion,
            schema_version AS schemaversion, heartbeat_at AS heartbeatat, lease_expires_at AS leaseexpiresat
        `,
        [
          input.role,
          input.ownerId,
          input.hostname ?? null,
          input.pid ?? null,
          input.priority,
          `schema-${APP_SCHEMA_VERSION}`,
          APP_SCHEMA_VERSION,
          now,
          expires,
          input.takeoverReason ?? null
        ]
      )).rows[0]
      await client.query('COMMIT')
      return this.row(row)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  public async touch(role: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE process_leases SET heartbeat_at = now(), lease_expires_at = $3 WHERE role = $1 AND owner_id = $2',
      [role, ownerId, new Date(Date.now() + leaseMs)]
    )
    return (result.rowCount ?? 0) > 0
  }

  public async release(role: string, ownerId: string): Promise<void> {
    await this.pool.query('DELETE FROM process_leases WHERE role = $1 AND owner_id = $2', [role, ownerId])
  }
}

import { Pool } from 'pg'
import {
  APP_SCHEMA_VERSION
} from './runtime-governance.ts'
import {
  buildRuntimeProcessStatuses,
  type RuntimeLeaseSnapshot,
  type RuntimeStatus
} from '@djbrain/shared/runtime-status.ts'
import { toNumber } from './collection-service-helpers.ts'

type RuntimeStatusFlags = RuntimeStatus['server']

type SchemaRow = { schemaversion: number | string }
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

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : String(value)

export class RuntimeStatusStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 })
  }

  public async dispose(): Promise<void> {
    await this.pool.end()
  }

  public async read(flags: RuntimeStatusFlags): Promise<RuntimeStatus> {
    const [schema, leases] = await Promise.all([this.readDatabaseSchemaVersion(), this.readLeases()])
    return {
      codeSchemaVersion: APP_SCHEMA_VERSION,
      databaseSchemaVersion: schema,
      server: flags,
      processes: buildRuntimeProcessStatuses(leases)
    }
  }

  private async readDatabaseSchemaVersion(): Promise<number | null> {
    const exists = (await this.pool.query<{ state: string | null }>("SELECT to_regclass('public.app_schema_state')::text AS state")).rows[0]?.state
    if (!exists) return null
    const row = (await this.pool.query<SchemaRow>('SELECT schema_version AS schemaversion FROM app_schema_state WHERE id = TRUE')).rows[0]
    return row ? toNumber(row.schemaversion) : null
  }

  private async readLeases(): Promise<RuntimeLeaseSnapshot[]> {
    const exists = (await this.pool.query<{ state: string | null }>("SELECT to_regclass('public.process_leases')::text AS state")).rows[0]?.state
    if (!exists) return []
    const rows = (await this.pool.query<LeaseRow>(`
      SELECT role, owner_id AS ownerid, hostname, pid, priority, code_version AS codeversion,
        schema_version AS schemaversion, heartbeat_at AS heartbeatat, lease_expires_at AS leaseexpiresat
      FROM process_leases
      ORDER BY role
    `)).rows
    return rows.map((row) => ({
      role: row.role,
      ownerId: row.ownerid,
      hostname: row.hostname,
      pid: row.pid == null ? null : toNumber(row.pid),
      priority: toNumber(row.priority),
      codeVersion: row.codeversion,
      schemaVersion: toNumber(row.schemaversion),
      heartbeatAt: iso(row.heartbeatat),
      leaseExpiresAt: iso(row.leaseexpiresat)
    }))
  }
}

export const APP_SCHEMA_VERSION = 2026051501

export type SchemaVersionDecision = { action: 'initialize' | 'upgrade' | 'ok'; version: number }

export type ProcessLeaseSnapshot = {
  role: string
  ownerId: string
  priority: number
  leaseExpiresAtMs: number
}

export type ProcessLeaseRequest = {
  ownerId: string
  priority: number
  takeover: boolean
  nowMs: number
}

type SchemaQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export function validateSchemaVersion(dbVersion: number | null, codeVersion: number = APP_SCHEMA_VERSION): SchemaVersionDecision {
  if (dbVersion == null) return { action: 'initialize', version: codeVersion }
  if (dbVersion > codeVersion) {
    throw new Error(`Database schema version ${dbVersion} is newer than this code version ${codeVersion}. Refusing to start.`)
  }
  return { action: dbVersion < codeVersion ? 'upgrade' : 'ok', version: codeVersion }
}

export async function ensureAppSchemaVersion(db: SchemaQueryable, write: boolean = true, codeVersion: number = APP_SCHEMA_VERSION): Promise<void> {
  const exists = (await db.query<{ state: string | null }>("SELECT to_regclass('public.app_schema_state')::text AS state")).rows[0]?.state
  if (write) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_schema_state (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        schema_version INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `)
  }
  const row = exists || write
    ? (await db.query<{ schema_version: number | string }>('SELECT schema_version FROM app_schema_state WHERE id = TRUE')).rows[0]
    : null
  const decision = validateSchemaVersion(row ? Number(row.schema_version) : null, codeVersion)
  if (!write) return
  if (decision.action === 'initialize') {
    await db.query('INSERT INTO app_schema_state(id, schema_version) VALUES (TRUE, $1) ON CONFLICT(id) DO NOTHING', [codeVersion])
  } else if (decision.action === 'upgrade') {
    await db.query('UPDATE app_schema_state SET schema_version = $1, updated_at = now() WHERE id = TRUE', [codeVersion])
  }
}

export function decideProcessLease(
  current: ProcessLeaseSnapshot | null,
  request: ProcessLeaseRequest
): { action: 'acquire' | 'deny'; reason: string } {
  if (!current) return { action: 'acquire', reason: 'empty' }
  if (current.ownerId === request.ownerId) return { action: 'acquire', reason: 'same_owner' }
  if (current.leaseExpiresAtMs <= request.nowMs) return { action: 'acquire', reason: 'expired' }
  if (request.takeover && request.priority > current.priority) return { action: 'acquire', reason: 'takeover' }
  return { action: 'deny', reason: `held_by:${current.ownerId}` }
}

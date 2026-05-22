import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureRecordingSourceClaimsTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS recording_source_claims (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id BIGINT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      external_key TEXT NOT NULL,
      artist TEXT,
      title TEXT,
      version TEXT,
      release_title TEXT,
      track_position TEXT,
      year TEXT,
      duration_seconds DOUBLE PRECISION,
      confidence INTEGER NOT NULL DEFAULT 0,
      raw_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider, entity_type, external_key)
    );

    CREATE INDEX IF NOT EXISTS recording_source_claims_recording_idx
    ON recording_source_claims(recording_id);
  `)

  await db.query(`
    DELETE FROM recording_source_claims
    WHERE provider = 'manual'
      AND entity_type = 'file_parse'
      AND COALESCE(raw_json->>'source', '') = 'identify_search_override'
  `)
}

import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureRecordingsTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS recordings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      canonical_artist TEXT,
      canonical_title TEXT,
      canonical_version TEXT,
      canonical_year TEXT,
      duration_seconds DOUBLE PRECISION,
      canonical_norm_key TEXT,
      confidence INTEGER NOT NULL DEFAULT 0,
      review_state TEXT NOT NULL DEFAULT 'auto',
      metadata_locked BOOLEAN NOT NULL DEFAULT FALSE,
      merged_into_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS recordings_canonical_norm_key_idx
    ON recordings(canonical_norm_key);
  `)

  await db.query(`
    ALTER TABLE recordings
    ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION
  `)
}

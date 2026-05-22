import type { Pool, PoolClient } from 'pg'
import { IDENTIFY_VERSION } from '@djbrain/shared/analysis-version'

type Db = Pool | PoolClient

export async function ensureFileIdentificationStateTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS file_identification_state (
      filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
      filesize BIGINT NOT NULL,
      mtime_ms BIGINT NOT NULL,
      recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
      audio_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assignment_method TEXT,
      confidence INTEGER,
      parsed_artist TEXT,
      parsed_title TEXT,
      parsed_version TEXT,
      parsed_year TEXT,
      tag_artist TEXT,
      tag_title TEXT,
      tag_version TEXT,
      chosen_claim_id BIGINT REFERENCES recording_source_claims(id) ON DELETE SET NULL,
      identify_version INTEGER NOT NULL DEFAULT ${IDENTIFY_VERSION},
      explanation_json JSONB,
      review_data JSONB,
      verified_at TIMESTAMPTZ,
      error_message TEXT,
      processed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS file_identification_state_status_idx
    ON file_identification_state(status, processed_at, filename);
  `)

  await db.query(`
    ALTER TABLE file_identification_state
    ADD COLUMN IF NOT EXISTS review_data JSONB
  `)

  await db.query(`
    ALTER TABLE file_identification_state
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ
  `)

  await db.query(`
    UPDATE file_identification_state
    SET verified_at = COALESCE(verified_at, processed_at)
    WHERE assignment_method = 'manual' AND verified_at IS NULL
  `)
}

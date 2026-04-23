import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureFileIdentificationArchiveTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS file_identification_archive (
      filename TEXT PRIMARY KEY,
      filesize BIGINT NOT NULL,
      mtime_ms BIGINT NOT NULL,
      recording_id BIGINT,
      audio_hash TEXT,
      status TEXT NOT NULL,
      assignment_method TEXT,
      confidence INTEGER,
      parsed_artist TEXT,
      parsed_title TEXT,
      parsed_version TEXT,
      parsed_year TEXT,
      tag_artist TEXT,
      tag_title TEXT,
      tag_version TEXT,
      chosen_claim_id BIGINT,
      identify_version INTEGER NOT NULL,
      explanation_json JSONB,
      review_data JSONB,
      verified_at TIMESTAMPTZ,
      error_message TEXT,
      processed_at TIMESTAMPTZ,
      candidates_json JSONB,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

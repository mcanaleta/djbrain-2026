import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureFileIdentificationCandidatesTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS file_identification_candidates (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      filename TEXT NOT NULL REFERENCES collection_files(filename) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      external_key TEXT NOT NULL,
      proposed_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
      score INTEGER NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'candidate',
      payload_json JSONB,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS file_identification_candidates_filename_idx
    ON file_identification_candidates(filename, score DESC, id);
  `)
}

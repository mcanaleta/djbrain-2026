import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureWantListTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS want_list (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id BIGINT REFERENCES recordings(id) ON DELETE CASCADE,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT,
      length TEXT,
      year TEXT,
      album TEXT,
      label TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      pipeline_status TEXT NOT NULL DEFAULT 'idle',
      search_id TEXT,
      search_result_count INTEGER NOT NULL DEFAULT 0,
      best_candidates_json TEXT,
      download_username TEXT,
      download_filename TEXT,
      pipeline_error TEXT,
      discogs_release_id BIGINT,
      discogs_track_position TEXT,
      discogs_entity_type TEXT,
      imported_filename TEXT
    );
  `)

  await db.query(`
    ALTER TABLE want_list
    ADD COLUMN IF NOT EXISTS recording_id BIGINT REFERENCES recordings(id) ON DELETE CASCADE
  `)
}

import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureUpgradeCasesTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS upgrade_cases (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      collection_filename TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'idle',
      search_artist TEXT NOT NULL,
      search_title TEXT NOT NULL,
      search_version TEXT,
      current_duration_seconds DOUBLE PRECISION,
      official_duration_seconds DOUBLE PRECISION,
      official_duration_source TEXT,
      reference_duration_seconds DOUBLE PRECISION,
      reference_duration_source TEXT,
      candidate_cache_json TEXT,
      local_candidates_json TEXT,
      selected_candidate_json TEXT,
      selected_local_filename TEXT,
      archive_filename TEXT,
      replacement_filename TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS upgrade_cases_status_idx
    ON upgrade_cases(status, updated_at DESC, id DESC);
  `)
}

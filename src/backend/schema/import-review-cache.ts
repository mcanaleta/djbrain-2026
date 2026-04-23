import type { Pool, PoolClient } from 'pg'
import { IMPORT_REVIEW_VERSION } from '../../shared/analysis-version.ts'

type Db = Pool | PoolClient

export async function ensureImportReviewCacheTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS import_review_cache (
      filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
      filesize BIGINT NOT NULL,
      mtime_ms BIGINT NOT NULL,
      review_version INTEGER NOT NULL DEFAULT ${IMPORT_REVIEW_VERSION},
      status TEXT NOT NULL DEFAULT 'pending',
      parsed_artist TEXT,
      parsed_title TEXT,
      parsed_version TEXT,
      parsed_year TEXT,
      review_json TEXT,
      error_message TEXT,
      processed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS import_review_cache_status_idx
    ON import_review_cache(status, processed_at, filename);
  `)
}

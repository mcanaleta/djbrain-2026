import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureCollectionFileStateTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS collection_file_state (
      filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
      mtime_ms BIGINT NOT NULL
    );
  `)
}

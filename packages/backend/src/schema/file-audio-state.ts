import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureFileAudioStateTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS file_audio_state (
      filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
      filesize BIGINT NOT NULL,
      mtime_ms BIGINT NOT NULL,
      hash_version INTEGER NOT NULL,
      audio_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      processed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS file_audio_state_status_idx
    ON file_audio_state(status, processed_at, filename);
  `)
}

import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureAudioAnalysisCacheTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audio_analysis_cache (
      audio_hash TEXT NOT NULL,
      analysis_version INTEGER NOT NULL,
      analysis_json TEXT,
      error_message TEXT,
      processed_at TIMESTAMPTZ,
      PRIMARY KEY(audio_hash, analysis_version)
    );
  `)
}

import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

export async function ensureAudioIdentificationCandidatesTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audio_identification_candidates (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      audio_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      external_key TEXT NOT NULL,
      proposed_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
      score INTEGER NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'candidate',
      payload_json JSONB,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(audio_hash, provider, entity_type, external_key)
    );

    CREATE INDEX IF NOT EXISTS audio_identification_candidates_hash_idx
    ON audio_identification_candidates(audio_hash, score DESC, id);
  `)

  await db.query(`
    WITH winners AS (
      SELECT DISTINCT ON (state.audio_hash)
        state.audio_hash,
        state.filename
      FROM file_identification_state state
      WHERE state.audio_hash IS NOT NULL
      ORDER BY
        state.audio_hash,
        (state.verified_at IS NOT NULL) DESC,
        CASE state.status WHEN 'ready' THEN 3 WHEN 'needs_review' THEN 2 WHEN 'processing' THEN 1 ELSE 0 END DESC,
        state.processed_at DESC NULLS LAST,
        state.filename
    )
    INSERT INTO audio_identification_candidates(
      audio_hash, provider, entity_type, external_key, proposed_recording_id, score, disposition, payload_json, processed_at
    )
    SELECT
      winners.audio_hash,
      candidate.provider,
      candidate.entity_type,
      candidate.external_key,
      candidate.proposed_recording_id,
      candidate.score,
      candidate.disposition,
      candidate.payload_json,
      candidate.processed_at
    FROM winners
    JOIN file_identification_candidates candidate ON candidate.filename = winners.filename
    ON CONFLICT(audio_hash, provider, entity_type, external_key) DO UPDATE SET
      proposed_recording_id = EXCLUDED.proposed_recording_id,
      score = EXCLUDED.score,
      disposition = EXCLUDED.disposition,
      payload_json = EXCLUDED.payload_json,
      processed_at = EXCLUDED.processed_at
  `)
}

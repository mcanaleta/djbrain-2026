import type { Pool, PoolClient } from 'pg'
import { IDENTIFY_VERSION } from '../../shared/analysis-version.ts'

type Db = Pool | PoolClient

export async function ensureAudioHashesTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audio_hashes (
      audio_hash TEXT PRIMARY KEY,
      recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
      duration_seconds DOUBLE PRECISION,
      assigned_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assignment_method TEXT,
      confidence INTEGER NOT NULL DEFAULT 0,
      chosen_claim_id BIGINT REFERENCES recording_source_claims(id) ON DELETE SET NULL,
      identify_version INTEGER NOT NULL DEFAULT ${IDENTIFY_VERSION},
      explanation_json JSONB,
      review_data JSONB,
      verified_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS audio_hashes_status_idx
    ON audio_hashes(status, processed_at, audio_hash);
  `)

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audio_assets') THEN
        INSERT INTO audio_hashes(
          audio_hash, recording_id, duration_seconds, assigned_by, confidence, created_at, updated_at
        )
        SELECT
          audio_hash, recording_id, duration_seconds, assigned_by, confidence, created_at, updated_at
        FROM audio_assets
        ON CONFLICT(audio_hash) DO UPDATE SET
          recording_id = COALESCE(EXCLUDED.recording_id, audio_hashes.recording_id),
          duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_hashes.duration_seconds),
          assigned_by = COALESCE(EXCLUDED.assigned_by, audio_hashes.assigned_by),
          confidence = GREATEST(audio_hashes.confidence, EXCLUDED.confidence),
          created_at = LEAST(audio_hashes.created_at, EXCLUDED.created_at),
          updated_at = GREATEST(audio_hashes.updated_at, EXCLUDED.updated_at);
      END IF;
    END
    $$;
  `)

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audio_identification_state') THEN
        INSERT INTO audio_hashes(
          audio_hash, recording_id, status, assignment_method, confidence, chosen_claim_id,
          identify_version, explanation_json, review_data, verified_at, error_message, processed_at
        )
        SELECT
          audio_hash, recording_id, status, assignment_method, COALESCE(confidence, 0), chosen_claim_id,
          identify_version, explanation_json, review_data, verified_at, error_message, processed_at
        FROM audio_identification_state
        ON CONFLICT(audio_hash) DO UPDATE SET
          recording_id = COALESCE(EXCLUDED.recording_id, audio_hashes.recording_id),
          status = EXCLUDED.status,
          assignment_method = EXCLUDED.assignment_method,
          confidence = GREATEST(audio_hashes.confidence, EXCLUDED.confidence),
          chosen_claim_id = EXCLUDED.chosen_claim_id,
          identify_version = GREATEST(audio_hashes.identify_version, EXCLUDED.identify_version),
          explanation_json = EXCLUDED.explanation_json,
          review_data = EXCLUDED.review_data,
          verified_at = EXCLUDED.verified_at,
          error_message = EXCLUDED.error_message,
          processed_at = EXCLUDED.processed_at,
          updated_at = now();
      END IF;
    END
    $$;
  `)

  await db.query(`
    WITH winners AS (
      SELECT DISTINCT ON (audio_hash)
        audio_hash,
        recording_id,
        status,
        assignment_method,
        confidence,
        chosen_claim_id,
        identify_version,
        explanation_json,
        review_data,
        verified_at,
        error_message,
        processed_at,
        filename
      FROM file_identification_state
      WHERE audio_hash IS NOT NULL
      ORDER BY
        audio_hash,
        (verified_at IS NOT NULL) DESC,
        CASE status WHEN 'ready' THEN 3 WHEN 'needs_review' THEN 2 WHEN 'processing' THEN 1 ELSE 0 END DESC,
        processed_at DESC NULLS LAST,
        filename
    )
    INSERT INTO audio_hashes(
      audio_hash, recording_id, status, assignment_method, confidence, chosen_claim_id,
      identify_version, explanation_json, review_data, verified_at, error_message, processed_at
    )
    SELECT
      audio_hash, recording_id, status, assignment_method, COALESCE(confidence, 0), chosen_claim_id,
      identify_version, explanation_json, review_data, verified_at, error_message, processed_at
    FROM winners
    ON CONFLICT(audio_hash) DO UPDATE SET
      recording_id = COALESCE(EXCLUDED.recording_id, audio_hashes.recording_id),
      status = EXCLUDED.status,
      assignment_method = EXCLUDED.assignment_method,
      confidence = GREATEST(audio_hashes.confidence, EXCLUDED.confidence),
      chosen_claim_id = EXCLUDED.chosen_claim_id,
      identify_version = GREATEST(audio_hashes.identify_version, EXCLUDED.identify_version),
      explanation_json = EXCLUDED.explanation_json,
      review_data = EXCLUDED.review_data,
      verified_at = EXCLUDED.verified_at,
      error_message = EXCLUDED.error_message,
      processed_at = EXCLUDED.processed_at
  `)

  await db.query(`
    UPDATE audio_hashes
    SET
      status = 'ready',
      assignment_method = COALESCE(assignment_method, 'audio_hash'),
      processed_at = COALESCE(processed_at, updated_at),
      updated_at = now()
    WHERE recording_id IS NOT NULL
      AND status = 'pending'
      AND assignment_method IS NULL
      AND chosen_claim_id IS NULL
      AND review_data IS NULL
      AND verified_at IS NULL
      AND error_message IS NULL
  `)
}

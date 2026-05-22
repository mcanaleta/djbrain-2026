import type { Pool, PoolClient } from 'pg'
import type {
  IdentifyReviewData,
  IdentificationAssignmentMethod,
  IdentificationStatus
} from '@djbrain/shared/api'
import type { RecordingCandidateSuggestion } from './recording-identity-service.ts'
import { toNumber } from './collection-service-helpers.ts'

function normalizeJsonText(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return null
  }
}

export async function syncFileIdentificationStateFromAudioState(
  db: Pool | PoolClient,
  audioHash?: string,
  filenames?: string[]
): Promise<void> {
  await db.query(
    `
      UPDATE file_identification_state state
      SET
        recording_id = audio.recording_id,
        status = audio.status,
        assignment_method = audio.assignment_method,
        confidence = audio.confidence,
        chosen_claim_id = audio.chosen_claim_id,
        identify_version = GREATEST(state.identify_version, audio.identify_version),
        explanation_json = audio.explanation_json,
        review_data = audio.review_data,
        verified_at = audio.verified_at,
        error_message = audio.error_message,
        processed_at = audio.processed_at
      FROM audio_hashes audio
      WHERE state.audio_hash = audio.audio_hash
        AND ($1::text IS NULL OR audio.audio_hash = $1::text)
        AND ($2::text[] IS NULL OR state.filename = ANY($2::text[]))
    `,
    [audioHash ?? null, filenames ?? null]
  )
}

export async function upsertAudioIdentificationState(
  client: PoolClient,
  audioHash: string,
  data: {
    recordingId: number | null
    status: IdentificationStatus
    assignmentMethod: IdentificationAssignmentMethod | null
    confidence: number | null
    chosenClaimId: number | null
    identifyVersion: number
    explanationJson: string | null
    reviewData: IdentifyReviewData | null
    verifiedAt: string | null
    errorMessage: string | null
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO audio_hashes(
        audio_hash, recording_id, status, assignment_method, confidence, chosen_claim_id,
        identify_version, explanation_json, review_data, verified_at, error_message, processed_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, now(), now())
      ON CONFLICT(audio_hash) DO UPDATE SET
        recording_id = COALESCE(EXCLUDED.recording_id, audio_hashes.recording_id),
        status = EXCLUDED.status,
        assignment_method = EXCLUDED.assignment_method,
        confidence = EXCLUDED.confidence,
        chosen_claim_id = EXCLUDED.chosen_claim_id,
        identify_version = GREATEST(audio_hashes.identify_version, EXCLUDED.identify_version),
        explanation_json = EXCLUDED.explanation_json,
        review_data = EXCLUDED.review_data,
        verified_at = EXCLUDED.verified_at,
        error_message = EXCLUDED.error_message,
        processed_at = EXCLUDED.processed_at,
        updated_at = now()
    `,
    [
      audioHash,
      data.recordingId,
      data.status,
      data.assignmentMethod,
      data.confidence,
      data.chosenClaimId,
      data.identifyVersion,
      normalizeJsonText(data.explanationJson),
      normalizeJsonText(data.reviewData ? JSON.stringify(data.reviewData) : null),
      data.verifiedAt,
      data.errorMessage
    ]
  )
}

export async function replaceAudioIdentificationCandidates(
  client: PoolClient,
  audioHash: string,
  candidates: RecordingCandidateSuggestion[]
): Promise<Map<string, number>> {
  const candidateIds = new Map<string, number>()
  await client.query(`DELETE FROM audio_identification_candidates WHERE audio_hash = $1`, [audioHash])
  for (const candidate of candidates) {
    const row = (
      await client.query<{ id: number | bigint }>(
        `
          INSERT INTO audio_identification_candidates(
            audio_hash, provider, entity_type, external_key, proposed_recording_id, score, disposition, payload_json, processed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
          RETURNING id
        `,
        [
          audioHash,
          candidate.provider,
          candidate.entityType,
          candidate.externalKey,
          candidate.proposedRecordingId,
          candidate.score,
          candidate.disposition,
          normalizeJsonText(candidate.payloadJson)
        ]
      )
    ).rows[0]
    if (row) candidateIds.set(candidate.externalKey, toNumber(row.id))
  }
  return candidateIds
}

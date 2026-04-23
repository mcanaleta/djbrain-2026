import type { Pool, PoolClient } from 'pg'
import type { RecordingCanonical } from '../shared/api.ts'
import type { RecordingClaimInput, RecordingMatchRow, SourceClaimMatch } from './recording-identity-service.ts'
import { toNumber } from './collection-service-helpers.ts'

function toCanonical(
  artist: string | null | undefined,
  title: string | null | undefined,
  version: string | null | undefined,
  year: string | null | undefined
): RecordingCanonical | null {
  return artist || title || version || year ? { artist: artist ?? null, title: title ?? null, version: version ?? null, year: year ?? null } : null
}

export async function materializeRecordingDurations(recordingIds: number[] | undefined, db: Pool | PoolClient): Promise<void> {
  const values = recordingIds && recordingIds.length > 0 ? [recordingIds] : []
  const whereSql = recordingIds && recordingIds.length > 0 ? 'WHERE recordings.id = ANY($1::bigint[])' : ''
  await db.query(
    `
      UPDATE recordings
      SET
        duration_seconds = candidate.duration_seconds,
        updated_at = now()
      FROM (
        SELECT
          recordings.id,
          COALESCE(
            (
              SELECT recording_source_claims.duration_seconds
              FROM recording_source_claims
              WHERE recording_source_claims.recording_id = recordings.id
                AND recording_source_claims.duration_seconds IS NOT NULL
              ORDER BY recording_source_claims.confidence DESC, recording_source_claims.updated_at DESC, recording_source_claims.id DESC
              LIMIT 1
            ),
            (
              SELECT audio_hashes.duration_seconds
              FROM audio_hashes
              WHERE audio_hashes.recording_id = recordings.id
                AND audio_hashes.duration_seconds IS NOT NULL
              ORDER BY audio_hashes.confidence DESC, audio_hashes.updated_at DESC, audio_hashes.audio_hash
              LIMIT 1
            )
          ) AS duration_seconds
        FROM recordings
        ${whereSql}
      ) AS candidate
      WHERE recordings.id = candidate.id
        AND recordings.duration_seconds IS DISTINCT FROM candidate.duration_seconds
    `,
    values
  )
}

export async function findRecordingByAudioHash(pool: Pool, audioHash: string): Promise<{ recordingId: number; canonical: RecordingCanonical | null } | null> {
  const row = (
    await pool.query<{
      recordingid: number | bigint
      canonicalartist: string | null
      canonicaltitle: string | null
      canonicalversion: string | null
      canonicalyear: string | null
    }>(
      `
        SELECT
          recordings.id AS recordingId,
          recordings.canonical_artist AS canonicalArtist,
          recordings.canonical_title AS canonicalTitle,
          recordings.canonical_version AS canonicalVersion,
          recordings.canonical_year AS canonicalYear
        FROM audio_hashes
        JOIN recordings ON recordings.id = audio_hashes.recording_id
        WHERE audio_hashes.audio_hash = $1 AND recordings.merged_into_recording_id IS NULL
        LIMIT 1
      `,
      [audioHash]
    )
  ).rows[0]
  return row
    ? {
        recordingId: toNumber(row.recordingid),
        canonical: toCanonical(row.canonicalartist, row.canonicaltitle, row.canonicalversion, row.canonicalyear)
      }
    : null
}

export async function findSourceClaimMatches(pool: Pool, externalKeys: string[]): Promise<SourceClaimMatch[]> {
  const keys = [...new Set(externalKeys.filter(Boolean))]
  if (keys.length === 0) return []
  return (
    await pool.query<{
      claimid: number | bigint
      recordingid: number | bigint
      externalkey: string
      confidence: number
      canonicalartist: string | null
      canonicaltitle: string | null
      canonicalversion: string | null
      canonicalyear: string | null
    }>(
      `
        SELECT
          recording_source_claims.id AS claimId,
          recording_source_claims.recording_id AS recordingId,
          recording_source_claims.external_key AS externalKey,
          recording_source_claims.confidence AS confidence,
          recordings.canonical_artist AS canonicalArtist,
          recordings.canonical_title AS canonicalTitle,
          recordings.canonical_version AS canonicalVersion,
          recordings.canonical_year AS canonicalYear
        FROM recording_source_claims
        JOIN recordings ON recordings.id = recording_source_claims.recording_id
        WHERE recording_source_claims.external_key = ANY($1::text[])
          AND recordings.merged_into_recording_id IS NULL
      `,
      [keys]
    )
  ).rows.map((row) => ({
    claimId: toNumber(row.claimid),
    recordingId: toNumber(row.recordingid),
    externalKey: row.externalkey,
    confidence: row.confidence,
    canonical: toCanonical(row.canonicalartist, row.canonicaltitle, row.canonicalversion, row.canonicalyear) ?? { artist: null, title: null, version: null, year: null }
  }))
}

export async function listRecordingsForMatching(pool: Pool): Promise<RecordingMatchRow[]> {
  const recordings = (
    await pool.query<{
      id: number | bigint
      canonicalartist: string | null
      canonicaltitle: string | null
      canonicalversion: string | null
      canonicalyear: string | null
      confidence: number
      reviewstate: 'auto' | 'confirmed' | 'merged'
      metadatalocked: boolean
      mergedintorecordingid: number | bigint | null
    }>(
      `
        SELECT
          id,
          canonical_artist AS canonicalArtist,
          canonical_title AS canonicalTitle,
          canonical_version AS canonicalVersion,
          canonical_year AS canonicalYear,
          confidence,
          review_state AS reviewState,
          metadata_locked AS metadataLocked,
          merged_into_recording_id AS mergedIntoRecordingId
        FROM recordings
        WHERE merged_into_recording_id IS NULL
      `
    )
  ).rows
  if (recordings.length === 0) return []

  const claims = (
    await pool.query<{
      recordingid: number | bigint
      provider: RecordingClaimInput['provider']
      entitytype: RecordingClaimInput['entityType']
      externalkey: string
      artist: string | null
      title: string | null
      version: string | null
      releasetitle: string | null
      trackposition: string | null
      year: string | null
      durationseconds: number | null
      confidence: number
      rawjson: unknown | null
    }>(
      `
        SELECT
          recording_id AS recordingId,
          provider,
          entity_type AS entityType,
          external_key AS externalKey,
          artist,
          title,
          version,
          release_title AS releaseTitle,
          track_position AS trackPosition,
          year,
          duration_seconds AS durationSeconds,
          confidence,
          raw_json AS rawJson
        FROM recording_source_claims
        WHERE recording_id = ANY($1::bigint[])
      `,
      [recordings.map((row) => toNumber(row.id))]
    )
  ).rows
  const claimsByRecording = new Map<number, RecordingClaimInput[]>()
  for (const row of claims) {
    const recordingId = toNumber(row.recordingid)
    const bucket = claimsByRecording.get(recordingId) ?? []
    bucket.push({
      provider: row.provider,
      entityType: row.entitytype,
      externalKey: row.externalkey,
      artist: row.artist,
      title: row.title,
      version: row.version,
      releaseTitle: row.releasetitle,
      trackPosition: row.trackposition,
      year: row.year,
      durationSeconds: row.durationseconds,
      confidence: row.confidence,
      rawJson: row.rawjson == null ? null : JSON.stringify(row.rawjson)
    })
    claimsByRecording.set(recordingId, bucket)
  }
  return recordings.map((row) => ({
    id: toNumber(row.id),
    canonical: toCanonical(row.canonicalartist, row.canonicaltitle, row.canonicalversion, row.canonicalyear) ?? { artist: null, title: null, version: null, year: null },
    confidence: row.confidence,
    reviewState: row.reviewstate,
    metadataLocked: row.metadatalocked,
    mergedIntoRecordingId: row.mergedintorecordingid == null ? null : toNumber(row.mergedintorecordingid),
    claims: claimsByRecording.get(toNumber(row.id)) ?? []
  }))
}

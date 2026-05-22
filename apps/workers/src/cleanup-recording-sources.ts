import { readFileSync, existsSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'

type Canonical = { artist: string | null; title: string | null; version: string | null; year: string | null }
type RecordingRow = { id: number; canonical: Canonical; normKey: string | null }
type ClaimRow = { id: number; recordingId: number; artist: string | null; title: string | null; version: string | null; year: string | null; durationSeconds: number | null; confidence: number }

function envUrl(): string {
  if (process.env['DJBRAIN_POSTGRES_URL']) return process.env['DJBRAIN_POSTGRES_URL']
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue
    const match = readFileSync(file, 'utf8').match(/^DJBRAIN_POSTGRES_URL=(.*)$/m)
    if (match?.[1]) return match[1]
  }
  throw new Error('DJBRAIN_POSTGRES_URL not found')
}

function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function text(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return normalized || null
}

function artist(value: string | null | undefined): string | null {
  const normalized = text(value)
  if (!normalized) return null
  const withoutSuffix = normalized.replace(/\s+\(\d+\)$/g, '') || normalized
  const article = withoutSuffix.match(/^(.+),\s*(the|a|an)$/i)
  return article ? `${article[2][0].toUpperCase()}${article[2].slice(1).toLowerCase()} ${article[1].trim()}` : withoutSuffix
}

function canonical(row: Pick<ClaimRow, 'artist' | 'title' | 'version' | 'year'>): Canonical {
  return { artist: artist(row.artist), title: text(row.title), version: text(row.version), year: text(row.year) }
}

function normKey(value: Canonical): string {
  return [value.artist, value.title, value.version].map(normalize).filter(Boolean).join(':')
}

function chooseRepresentative(claims: ClaimRow[]): ClaimRow {
  return [...claims].sort((a, b) => b.confidence - a.confidence || Number(b.durationSeconds ?? -1) - Number(a.durationSeconds ?? -1) || b.id - a.id)[0]!
}

async function refreshRecording(client: PoolClient, recordingId: number): Promise<void> {
  const claims = (
    await client.query<ClaimRow>(
      `select id, recording_id as "recordingId", artist, title, version, year, duration_seconds as "durationSeconds", confidence from recording_source_claims where recording_id = $1 order by confidence desc, id desc`,
      [recordingId]
    )
  ).rows
  if (!claims.length) return
  const representative = chooseRepresentative(claims)
  const chosen = canonical(representative)
  const duration = claims.find((claim) => claim.durationSeconds != null)?.durationSeconds ?? null
  const confidence = Math.max(...claims.map((claim) => claim.confidence))
  await client.query(
    `update recordings
     set canonical_artist = $2,
         canonical_title = $3,
         canonical_version = $4,
         canonical_year = $5,
         canonical_norm_key = $6,
         duration_seconds = $7,
         confidence = $8,
         updated_at = now()
     where id = $1`,
    [recordingId, chosen.artist, chosen.title, chosen.version, chosen.year, normKey(chosen) || null, duration, confidence]
  )
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: envUrl() })
  const client = await pool.connect()
  try {
    const recordings = (
      await client.query<{ id: number | bigint; canonicalartist: string | null; canonicaltitle: string | null; canonicalversion: string | null; canonicalyear: string | null; canonicalnormkey: string | null }>(
        `select id, canonical_artist as canonicalArtist, canonical_title as canonicalTitle, canonical_version as canonicalVersion, canonical_year as canonicalYear, canonical_norm_key as canonicalNormKey from recordings where merged_into_recording_id is null`
      )
    ).rows.map((row) => ({
      id: Number(row.id),
      canonical: { artist: row.canonicalartist, title: row.canonicaltitle, version: row.canonicalversion, year: row.canonicalyear },
      normKey: row.canonicalnormkey
    })) satisfies RecordingRow[]
    const claims = (
      await client.query<{ id: number | bigint; recordingid: number | bigint; artist: string | null; title: string | null; version: string | null; year: string | null; durationseconds: number | null; confidence: number }>(
        `select id, recording_id as recordingId, artist, title, version, year, duration_seconds as durationSeconds, confidence from recording_source_claims order by recording_id, confidence desc, id desc`
      )
    ).rows.map((row) => ({
      id: Number(row.id),
      recordingId: Number(row.recordingid),
      artist: row.artist,
      title: row.title,
      version: row.version,
      year: row.year,
      durationSeconds: row.durationseconds,
      confidence: row.confidence
    })) satisfies ClaimRow[]

    const claimsByRecording = new Map<number, ClaimRow[]>()
    for (const claim of claims) {
      const bucket = claimsByRecording.get(claim.recordingId) ?? []
      bucket.push(claim)
      claimsByRecording.set(claim.recordingId, bucket)
    }

    const recordingIdByKey = new Map(recordings.map((row) => [row.normKey ?? normKey(row.canonical), row.id] as const).filter(([key]) => Boolean(key)) as Array<[string, number]>)
    const affected = new Set<number>()
    let moved = 0
    let created = 0

    await client.query('begin')
    for (const recording of recordings) {
      const sourceClaims = claimsByRecording.get(recording.id) ?? []
      if (sourceClaims.length < 2) continue
      const groups = new Map<string, ClaimRow[]>()
      for (const claim of sourceClaims) {
        const key = normKey(canonical(claim))
        if (!key) continue
        const bucket = groups.get(key) ?? []
        bucket.push(claim)
        groups.set(key, bucket)
      }
      if (groups.size <= 1) continue
      const currentKey = recording.normKey ?? normKey(recording.canonical)
      const keepKey =
        groups.has(currentKey)
          ? currentKey
          : [...groups.entries()].sort((a, b) => b[1].length - a[1].length || chooseRepresentative(b[1]).confidence - chooseRepresentative(a[1]).confidence)[0]![0]
      for (const [key, group] of groups) {
        if (key === keepKey) continue
        let targetId = recordingIdByKey.get(key) ?? null
        if (targetId === recording.id) targetId = null
        if (targetId == null) {
          const rep = canonical(chooseRepresentative(group))
          const inserted = await client.query<{ id: number | bigint }>(
            `insert into recordings(canonical_artist, canonical_title, canonical_version, canonical_year, duration_seconds, canonical_norm_key, confidence, review_state, metadata_locked)
             values ($1,$2,$3,$4,$5,$6,$7,'auto',false) returning id`,
            [rep.artist, rep.title, rep.version, rep.year, group.find((claim) => claim.durationSeconds != null)?.durationSeconds ?? null, key, Math.max(...group.map((claim) => claim.confidence))]
          )
          targetId = Number(inserted.rows[0]!.id)
          recordingIdByKey.set(key, targetId)
          created += 1
        }
        await client.query(`update recording_source_claims set recording_id = $2, updated_at = now() where id = any($1::bigint[])`, [group.map((claim) => claim.id), targetId])
        moved += group.length
        affected.add(recording.id)
        affected.add(targetId)
      }
    }
    for (const recordingId of affected) await refreshRecording(client, recordingId)
    await client.query('commit')
    console.log(JSON.stringify({ moved, created, touched: affected.size }, null, 2))
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

void main()

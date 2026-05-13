import type { Pool, PoolClient } from 'pg'
import type { DownloadAttempt, DownloadAttemptStatus } from './collection-service.ts'
import { toNumber } from './collection-service-helpers.ts'

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

type DownloadAttemptRow = {
  id: number | string
  want_list_id: number | string | null
  status: DownloadAttemptStatus
  origin_artist: string
  origin_title: string
  origin_version: string | null
  origin_year: string | null
  origin_album: string | null
  origin_label: string | null
  origin_source_collection_filename: string | null
  origin_discogs_release_id: number | string | null
  origin_discogs_track_position: string | null
  search_query: string | null
  slskd_search_id: string | null
  username: string | null
  remote_filename: string | null
  remote_size: number | string | null
  bitrate: number | string | null
  duration_seconds: number | string | null
  extension: string | null
  score: number | string | null
  queue_length: number | string | null
  has_free_upload_slot: boolean | null
  upload_speed: number | string | null
  is_locked: boolean | null
  raw_candidate_json: string | null
  local_filename: string | null
  local_filesize: number | string | null
  error_message: string | null
  requested_at: Date | string | null
  completed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

export type DownloadAttemptCreateInput = {
  wantListId: number | null
  status: DownloadAttemptStatus
  originArtist: string
  originTitle: string
  originVersion?: string | null
  originYear?: string | null
  originAlbum?: string | null
  originLabel?: string | null
  originSourceCollectionFilename?: string | null
  originDiscogsReleaseId?: number | null
  originDiscogsTrackPosition?: string | null
  searchQuery?: string | null
  slskdSearchId?: string | null
  username?: string | null
  remoteFilename?: string | null
  remoteSize?: number | null
  bitrate?: number | null
  durationSeconds?: number | null
  extension?: string | null
  score?: number | null
  queueLength?: number | null
  hasFreeUploadSlot?: boolean | null
  uploadSpeed?: number | null
  isLocked?: boolean | null
  rawCandidateJson?: string | null
  localFilename?: string | null
  localFilesize?: number | null
  errorMessage?: string | null
}

export type DownloadAttemptPatch = Partial<Pick<DownloadAttemptCreateInput,
  'status' | 'slskdSearchId' | 'localFilename' | 'localFilesize' | 'errorMessage'
>> & {
  requestedAt?: string | null
  completedAt?: string | null
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

export class DownloadAttemptStore {
  private readonly db: Queryable

  private readonly columns = `
    id, want_list_id, status,
    origin_artist, origin_title, origin_version, origin_year, origin_album, origin_label,
    origin_source_collection_filename, origin_discogs_release_id, origin_discogs_track_position,
    search_query, slskd_search_id, username, remote_filename, remote_size,
    bitrate, duration_seconds, extension, score, queue_length, has_free_upload_slot, upload_speed,
    is_locked, raw_candidate_json, local_filename, local_filesize, error_message,
    requested_at, completed_at, created_at, updated_at
  `

  constructor(db: Queryable) {
    this.db = db
  }

  private rowToAttempt(row: DownloadAttemptRow): DownloadAttempt {
    return {
      id: toNumber(row.id),
      wantListId: row.want_list_id == null ? null : toNumber(row.want_list_id),
      status: row.status,
      originArtist: row.origin_artist,
      originTitle: row.origin_title,
      originVersion: row.origin_version ?? null,
      originYear: row.origin_year ?? null,
      originAlbum: row.origin_album ?? null,
      originLabel: row.origin_label ?? null,
      originSourceCollectionFilename: row.origin_source_collection_filename ?? null,
      originDiscogsReleaseId: row.origin_discogs_release_id == null ? null : toNumber(row.origin_discogs_release_id),
      originDiscogsTrackPosition: row.origin_discogs_track_position ?? null,
      searchQuery: row.search_query ?? null,
      slskdSearchId: row.slskd_search_id ?? null,
      username: row.username ?? null,
      remoteFilename: row.remote_filename ?? null,
      remoteSize: row.remote_size == null ? null : toNumber(row.remote_size),
      bitrate: row.bitrate == null ? null : toNumber(row.bitrate),
      durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
      extension: row.extension ?? null,
      score: row.score == null ? null : toNumber(row.score),
      queueLength: row.queue_length == null ? null : toNumber(row.queue_length),
      hasFreeUploadSlot: row.has_free_upload_slot ?? null,
      uploadSpeed: row.upload_speed == null ? null : toNumber(row.upload_speed),
      isLocked: row.is_locked ?? false,
      rawCandidateJson: row.raw_candidate_json ?? null,
      localFilename: row.local_filename ?? null,
      localFilesize: row.local_filesize == null ? null : toNumber(row.local_filesize),
      errorMessage: row.error_message ?? null,
      requestedAt: toIso(row.requested_at),
      completedAt: toIso(row.completed_at),
      createdAt: toIso(row.created_at) ?? new Date().toISOString(),
      updatedAt: toIso(row.updated_at) ?? new Date().toISOString()
    }
  }

  public async create(input: DownloadAttemptCreateInput): Promise<DownloadAttempt> {
    const row = (await this.db.query<DownloadAttemptRow>(
      `INSERT INTO download_attempts (
         want_list_id, status, origin_artist, origin_title, origin_version, origin_year, origin_album, origin_label,
         origin_source_collection_filename, origin_discogs_release_id, origin_discogs_track_position,
         search_query, slskd_search_id, username, remote_filename, remote_size,
         bitrate, duration_seconds, extension, score, queue_length, has_free_upload_slot, upload_speed,
         is_locked, raw_candidate_json, local_filename, local_filesize, error_message,
         requested_at, completed_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
         CASE WHEN $2 IN ('requested','downloading') THEN now() ELSE NULL END,
         CASE WHEN $2 = 'downloaded' THEN now() ELSE NULL END)
       RETURNING ${this.columns}`,
      [
        input.wantListId,
        input.status,
        input.originArtist,
        input.originTitle,
        input.originVersion ?? null,
        input.originYear ?? null,
        input.originAlbum ?? null,
        input.originLabel ?? null,
        input.originSourceCollectionFilename ?? null,
        input.originDiscogsReleaseId ?? null,
        input.originDiscogsTrackPosition ?? null,
        input.searchQuery ?? null,
        input.slskdSearchId ?? null,
        input.username ?? null,
        input.remoteFilename ?? null,
        input.remoteSize ?? null,
        input.bitrate ?? null,
        input.durationSeconds ?? null,
        input.extension ?? null,
        input.score ?? null,
        input.queueLength ?? null,
        input.hasFreeUploadSlot ?? null,
        input.uploadSpeed ?? null,
        input.isLocked ?? false,
        input.rawCandidateJson ?? null,
        input.localFilename ?? null,
        input.localFilesize ?? null,
        input.errorMessage ?? null
      ]
    )).rows[0]
    return this.rowToAttempt(row)
  }

  public async update(id: number, patch: DownloadAttemptPatch): Promise<DownloadAttempt | null> {
    const parts: string[] = ['updated_at = now()']
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      params.push(value)
      parts.push(`${column} = $${params.length}`)
    }
    if ('status' in patch) set('status', patch.status ?? 'queued')
    if ('slskdSearchId' in patch) set('slskd_search_id', patch.slskdSearchId ?? null)
    if ('localFilename' in patch) set('local_filename', patch.localFilename ?? null)
    if ('localFilesize' in patch) set('local_filesize', patch.localFilesize ?? null)
    if ('errorMessage' in patch) set('error_message', patch.errorMessage ?? null)
    if ('requestedAt' in patch) set('requested_at', patch.requestedAt ?? null)
    if ('completedAt' in patch) set('completed_at', patch.completedAt ?? null)
    params.push(id)
    const row = (await this.db.query<DownloadAttemptRow>(
      `UPDATE download_attempts SET ${parts.join(', ')} WHERE id = $${params.length} RETURNING ${this.columns}`,
      params
    )).rows[0]
    return row ? this.rowToAttempt(row) : null
  }

  public async listByWantListId(wantListId: number): Promise<DownloadAttempt[]> {
    return (await this.db.query<DownloadAttemptRow>(
      `SELECT ${this.columns} FROM download_attempts WHERE want_list_id = $1 ORDER BY updated_at DESC, id DESC`,
      [wantListId]
    )).rows.map((row) => this.rowToAttempt(row))
  }

  public async listActive(limit: number): Promise<DownloadAttempt[]> {
    return (await this.db.query<DownloadAttemptRow>(
      `SELECT ${this.columns}
       FROM download_attempts
       WHERE status IN ('queued', 'requested', 'downloading')
       ORDER BY updated_at, id
       LIMIT $1`,
      [Math.max(1, Math.trunc(limit))]
    )).rows.map((row) => this.rowToAttempt(row))
  }
}

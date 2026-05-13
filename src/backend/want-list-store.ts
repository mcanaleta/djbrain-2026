import type { Pool, PoolClient } from 'pg'
import type { WantListAddInput, WantListItem, WantListPipelinePatch } from './collection-service'
import { normalizeWantListInput, toNumber } from './collection-service-helpers.ts'

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

type WantListRow = {
  id: number | string
  artist: string
  title: string
  version: string | null
  length: string | null
  year: string | null
  album: string | null
  label: string | null
  added_at: Date | string
  pipeline_status: string | null
  search_id: string | null
  search_result_count: number | string | null
  best_candidates_json: string | null
  download_username: string | null
  download_filename: string | null
  pipeline_error: string | null
  discogs_release_id: number | string | null
  discogs_track_position: string | null
  discogs_entity_type: string | null
  imported_filename: string | null
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

export class WantListStore {
  private readonly columns = `
    id, artist, title, version, length, year, album, label, added_at,
    pipeline_status, search_id, search_result_count, best_candidates_json,
    download_username, download_filename, pipeline_error,
    discogs_release_id, discogs_track_position, discogs_entity_type, imported_filename
  `

  private readonly db: Queryable

  constructor(db: Queryable) {
    this.db = db
  }

  private rowToItem(row: WantListRow): WantListItem {
    return {
      id: toNumber(row.id),
      artist: row.artist,
      title: row.title,
      version: row.version ?? null,
      length: row.length ?? null,
      year: row.year ?? null,
      album: row.album ?? null,
      label: row.label ?? null,
      addedAt: toIso(row.added_at),
      pipelineStatus: row.pipeline_status ?? 'idle',
      searchId: row.search_id ?? null,
      searchResultCount: toNumber(row.search_result_count ?? 0),
      bestCandidatesJson: row.best_candidates_json ?? null,
      downloadUsername: row.download_username ?? null,
      downloadFilename: row.download_filename ?? null,
      pipelineError: row.pipeline_error ?? null,
      discogsReleaseId: row.discogs_release_id != null ? toNumber(row.discogs_release_id) : null,
      discogsTrackPosition: row.discogs_track_position ?? null,
      discogsEntityType: row.discogs_entity_type ?? null,
      importedFilename: row.imported_filename ?? null
    }
  }

  public async add(input: WantListAddInput): Promise<WantListItem> {
    const normalized = normalizeWantListInput(input)
    const result = await this.db.query<WantListRow>(
      `INSERT INTO want_list (artist, title, version, length, year, album, label, discogs_release_id, discogs_track_position, discogs_entity_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${this.columns}`,
      [
        normalized.artist,
        normalized.title,
        normalized.version ?? null,
        normalized.length ?? null,
        input.year ?? null,
        normalized.album ?? null,
        normalized.label ?? null,
        input.discogsReleaseId ?? null,
        input.discogsTrackPosition ?? null,
        input.discogsEntityType ?? null
      ]
    )
    return this.rowToItem(result.rows[0])
  }

  public async get(id: number): Promise<WantListItem | null> {
    const result = await this.db.query<WantListRow>(`SELECT ${this.columns} FROM want_list WHERE id = $1`, [id])
    const row = result.rows[0]
    return row ? this.rowToItem(row) : null
  }

  public async update(id: number, input: WantListAddInput): Promise<WantListItem | null> {
    const normalized = normalizeWantListInput(input)
    const result = await this.db.query<WantListRow>(
      `UPDATE want_list
       SET artist = $1, title = $2, version = $3, length = $4, year = $5, album = $6, label = $7
       WHERE id = $8
       RETURNING ${this.columns}`,
      [
        normalized.artist,
        normalized.title,
        normalized.version ?? null,
        normalized.length ?? null,
        input.year ?? null,
        normalized.album ?? null,
        normalized.label ?? null,
        id
      ]
    )
    const row = result.rows[0]
    return row ? this.rowToItem(row) : null
  }

  public async updatePipeline(id: number, patch: WantListPipelinePatch): Promise<WantListItem | null> {
    const parts: string[] = []
    const params: unknown[] = []

    if ('pipelineStatus' in patch) {
      params.push(patch.pipelineStatus ?? 'idle')
      parts.push(`pipeline_status = $${params.length}`)
    }
    if ('searchId' in patch) {
      params.push(patch.searchId ?? null)
      parts.push(`search_id = $${params.length}`)
    }
    if ('searchResultCount' in patch) {
      params.push(patch.searchResultCount ?? 0)
      parts.push(`search_result_count = $${params.length}`)
    }
    if ('bestCandidatesJson' in patch) {
      params.push(patch.bestCandidatesJson ?? null)
      parts.push(`best_candidates_json = $${params.length}`)
    }
    if ('downloadUsername' in patch) {
      params.push(patch.downloadUsername ?? null)
      parts.push(`download_username = $${params.length}`)
    }
    if ('downloadFilename' in patch) {
      params.push(patch.downloadFilename ?? null)
      parts.push(`download_filename = $${params.length}`)
    }
    if ('pipelineError' in patch) {
      params.push(patch.pipelineError ?? null)
      parts.push(`pipeline_error = $${params.length}`)
    }
    if ('discogsReleaseId' in patch) {
      params.push(patch.discogsReleaseId ?? null)
      parts.push(`discogs_release_id = $${params.length}`)
    }
    if ('discogsTrackPosition' in patch) {
      params.push(patch.discogsTrackPosition ?? null)
      parts.push(`discogs_track_position = $${params.length}`)
    }
    if ('importedFilename' in patch) {
      params.push(patch.importedFilename ?? null)
      parts.push(`imported_filename = $${params.length}`)
    }
    if (parts.length === 0) {
      return this.get(id)
    }

    params.push(id)
    const result = await this.db.query<WantListRow>(
      `UPDATE want_list SET ${parts.join(', ')} WHERE id = $${params.length} RETURNING ${this.columns}`,
      params
    )
    const row = result.rows[0]
    return row ? this.rowToItem(row) : null
  }

  public async remove(id: number): Promise<void> {
    await this.db.query(`DELETE FROM want_list WHERE id = $1`, [id])
  }

  public async list(): Promise<WantListItem[]> {
    const result = await this.db.query<WantListRow>(`SELECT ${this.columns} FROM want_list ORDER BY added_at DESC`)
    return result.rows.map((row) => this.rowToItem(row))
  }
}

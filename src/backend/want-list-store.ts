import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { WantListAddInput, WantListItem, WantListPipelinePatch } from './collection-service'
import { normalizeWantListInput, toNumber } from './collection-service-helpers.ts'

export class WantListStore {
  private readonly columns = `
    id, artist, title, version, length, year, album, label, added_at,
    pipeline_status, search_id, search_result_count, best_candidates_json,
    download_username, download_filename, pipeline_error,
    discogs_release_id, discogs_track_position, discogs_entity_type, imported_filename
  `

  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  private rowToItem(row: Record<string, unknown>): WantListItem {
    return {
      id: toNumber(row['id']),
      artist: row['artist'] as string,
      title: row['title'] as string,
      version: (row['version'] as string | null) ?? null,
      length: (row['length'] as string | null) ?? null,
      year: (row['year'] as string | null) ?? null,
      album: (row['album'] as string | null) ?? null,
      label: (row['label'] as string | null) ?? null,
      addedAt: row['added_at'] as string,
      pipelineStatus: (row['pipeline_status'] as string | null) ?? 'idle',
      searchId: (row['search_id'] as string | null) ?? null,
      searchResultCount: toNumber(row['search_result_count'] ?? 0),
      bestCandidatesJson: (row['best_candidates_json'] as string | null) ?? null,
      downloadUsername: (row['download_username'] as string | null) ?? null,
      downloadFilename: (row['download_filename'] as string | null) ?? null,
      pipelineError: (row['pipeline_error'] as string | null) ?? null,
      discogsReleaseId:
        row['discogs_release_id'] != null ? toNumber(row['discogs_release_id']) : null,
      discogsTrackPosition: (row['discogs_track_position'] as string | null) ?? null,
      discogsEntityType: (row['discogs_entity_type'] as string | null) ?? null,
      importedFilename: (row['imported_filename'] as string | null) ?? null
    }
  }

  public add(input: WantListAddInput): WantListItem {
    const normalized = normalizeWantListInput(input)
    const row = this.db
      .prepare(
        `INSERT INTO want_list (artist, title, version, length, year, album, label, discogs_release_id, discogs_track_position, discogs_entity_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${this.columns}`
      )
      .get(
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
      ) as Record<string, unknown>
    return this.rowToItem(row)
  }

  public get(id: number): WantListItem | null {
    const row = this.db
      .prepare(`SELECT ${this.columns} FROM want_list WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  public update(id: number, input: WantListAddInput): WantListItem | null {
    const normalized = normalizeWantListInput(input)
    const row = this.db
      .prepare(
        `UPDATE want_list
         SET artist = ?, title = ?, version = ?, length = ?, year = ?, album = ?, label = ?
         WHERE id = ?
         RETURNING ${this.columns}`
      )
      .get(
        normalized.artist,
        normalized.title,
        normalized.version ?? null,
        normalized.length ?? null,
        input.year ?? null,
        normalized.album ?? null,
        normalized.label ?? null,
        id
      ) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  public updatePipeline(id: number, patch: WantListPipelinePatch): WantListItem | null {
    const parts: string[] = []
    const params: SQLInputValue[] = []

    if ('pipelineStatus' in patch) {
      parts.push('pipeline_status = ?')
      params.push(patch.pipelineStatus ?? 'idle')
    }
    if ('searchId' in patch) {
      parts.push('search_id = ?')
      params.push(patch.searchId ?? null)
    }
    if ('searchResultCount' in patch) {
      parts.push('search_result_count = ?')
      params.push(patch.searchResultCount ?? 0)
    }
    if ('bestCandidatesJson' in patch) {
      parts.push('best_candidates_json = ?')
      params.push(patch.bestCandidatesJson ?? null)
    }
    if ('downloadUsername' in patch) {
      parts.push('download_username = ?')
      params.push(patch.downloadUsername ?? null)
    }
    if ('downloadFilename' in patch) {
      parts.push('download_filename = ?')
      params.push(patch.downloadFilename ?? null)
    }
    if ('pipelineError' in patch) {
      parts.push('pipeline_error = ?')
      params.push(patch.pipelineError ?? null)
    }
    if ('discogsReleaseId' in patch) {
      parts.push('discogs_release_id = ?')
      params.push(patch.discogsReleaseId ?? null)
    }
    if ('discogsTrackPosition' in patch) {
      parts.push('discogs_track_position = ?')
      params.push(patch.discogsTrackPosition ?? null)
    }
    if ('importedFilename' in patch) {
      parts.push('imported_filename = ?')
      params.push(patch.importedFilename ?? null)
    }
    if (parts.length === 0) {
      return this.get(id)
    }

    params.push(id)
    const row = this.db
      .prepare(`UPDATE want_list SET ${parts.join(', ')} WHERE id = ? RETURNING ${this.columns}`)
      .get(...params) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  public remove(id: number): void {
    this.db.prepare(`DELETE FROM want_list WHERE id = ?`).run(id)
  }

  public list(): WantListItem[] {
    const rows = this.db
      .prepare(`SELECT ${this.columns} FROM want_list ORDER BY added_at DESC`)
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToItem(row))
  }
}

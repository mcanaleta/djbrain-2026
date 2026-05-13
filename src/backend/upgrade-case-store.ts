import type { Pool, PoolClient } from 'pg'
import type {
  UpgradeCandidate,
  UpgradeCase,
  UpgradeCaseStatus,
  UpgradeLocalCandidate,
  UpgradeReferenceSource
} from '../shared/api.ts'
import { normalizeFilename, toNumber } from './collection-service-helpers.ts'

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

type UpgradeCaseRow = {
  id: number | string
  collection_filename: string
  status: UpgradeCaseStatus | null
  search_artist: string | null
  search_title: string | null
  search_version: string | null
  current_duration_seconds: number | null
  official_duration_seconds: number | null
  official_duration_source: UpgradeReferenceSource | null
  reference_duration_seconds: number | null
  reference_duration_source: UpgradeReferenceSource | null
  candidate_cache_json: string | null
  local_candidates_json: string | null
  selected_candidate_json: string | null
  selected_local_filename: string | null
  archive_filename: string | null
  replacement_filename: string | null
  last_error: string | null
  created_at: Date | string
  updated_at: Date | string
  completed_at: Date | string | null
}

export type UpgradeCaseCreateInput = {
  collectionFilename: string
  searchArtist: string
  searchTitle: string
  searchVersion: string | null
  currentDurationSeconds: number | null
  officialDurationSeconds: number | null
  officialDurationSource: UpgradeReferenceSource | null
  referenceDurationSeconds: number | null
  referenceDurationSource: UpgradeReferenceSource | null
}

export type UpgradeCasePatch = {
  collectionFilename?: string
  status?: UpgradeCaseStatus
  searchArtist?: string
  searchTitle?: string
  searchVersion?: string | null
  currentDurationSeconds?: number | null
  officialDurationSeconds?: number | null
  officialDurationSource?: UpgradeReferenceSource | null
  referenceDurationSeconds?: number | null
  referenceDurationSource?: UpgradeReferenceSource | null
  candidateCacheJson?: string | null
  localCandidatesJson?: string | null
  selectedCandidateJson?: string | null
  selectedLocalFilename?: string | null
  archiveFilename?: string | null
  replacementFilename?: string | null
  lastError?: string | null
  completedAt?: string | null
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function parseCandidate(value: string | null | undefined): UpgradeCandidate | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as UpgradeCandidate
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseCandidates(value: string | null | undefined): UpgradeCandidate[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as UpgradeCandidate[]) : []
  } catch {
    return []
  }
}

function parseLocalCandidates(value: string | null | undefined): UpgradeLocalCandidate[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as UpgradeLocalCandidate[]) : []
  } catch {
    return []
  }
}

function countCandidates(value: string | null | undefined): number {
  return parseCandidates(value).length
}

function countLocalCandidates(value: string | null | undefined): number {
  return parseLocalCandidates(value).length
}

export class UpgradeCaseStore {
  private readonly db: Queryable

  private readonly columns = `
    id, collection_filename, status,
    search_artist, search_title, search_version,
    current_duration_seconds, official_duration_seconds, official_duration_source,
    reference_duration_seconds, reference_duration_source,
    candidate_cache_json, local_candidates_json, selected_candidate_json, selected_local_filename,
    archive_filename, replacement_filename, last_error,
    created_at, updated_at, completed_at
  `

  constructor(db: Queryable) {
    this.db = db
  }

  private rowToCase(row: UpgradeCaseRow): UpgradeCase {
    return {
      id: toNumber(row.id),
      collectionFilename: row.collection_filename,
      status: row.status ?? 'idle',
      searchArtist: row.search_artist ?? '',
      searchTitle: row.search_title ?? '',
      searchVersion: row.search_version ?? null,
      currentDurationSeconds: row.current_duration_seconds == null ? null : Number(row.current_duration_seconds),
      officialDurationSeconds: row.official_duration_seconds == null ? null : Number(row.official_duration_seconds),
      officialDurationSource: row.official_duration_source ?? null,
      referenceDurationSeconds: row.reference_duration_seconds == null ? null : Number(row.reference_duration_seconds),
      referenceDurationSource: row.reference_duration_source ?? null,
      candidateCount: countCandidates(row.candidate_cache_json ?? null),
      localCandidateCount: countLocalCandidates(row.local_candidates_json ?? null),
      selectedCandidate: parseCandidate(row.selected_candidate_json ?? null),
      selectedLocalFilename: row.selected_local_filename ?? null,
      archiveFilename: row.archive_filename ?? null,
      replacementFilename: row.replacement_filename ?? null,
      lastError: row.last_error ?? null,
      createdAt: toIso(row.created_at) ?? new Date().toISOString(),
      updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
      completedAt: toIso(row.completed_at)
    }
  }

  public async add(input: UpgradeCaseCreateInput): Promise<UpgradeCase> {
    const result = await this.db.query<UpgradeCaseRow>(
      `INSERT INTO upgrade_cases (
         collection_filename, search_artist, search_title, search_version,
         current_duration_seconds, official_duration_seconds, official_duration_source,
         reference_duration_seconds, reference_duration_source
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(collection_filename) DO UPDATE SET
         search_artist = CASE
           WHEN trim(upgrade_cases.search_artist) = '' THEN excluded.search_artist
           ELSE upgrade_cases.search_artist
         END,
         search_title = CASE
           WHEN trim(upgrade_cases.search_title) = '' THEN excluded.search_title
           ELSE upgrade_cases.search_title
         END,
         search_version = COALESCE(upgrade_cases.search_version, excluded.search_version),
         current_duration_seconds = excluded.current_duration_seconds,
         official_duration_seconds = COALESCE(excluded.official_duration_seconds, upgrade_cases.official_duration_seconds),
         official_duration_source = COALESCE(excluded.official_duration_source, upgrade_cases.official_duration_source),
         reference_duration_seconds = COALESCE(excluded.reference_duration_seconds, upgrade_cases.reference_duration_seconds),
         reference_duration_source = COALESCE(excluded.reference_duration_source, upgrade_cases.reference_duration_source),
         updated_at = now()
       RETURNING ${this.columns}`,
      [
        normalizeFilename(input.collectionFilename),
        normalizeText(input.searchArtist),
        normalizeText(input.searchTitle),
        normalizeText(input.searchVersion) || null,
        input.currentDurationSeconds,
        input.officialDurationSeconds,
        input.officialDurationSource,
        input.referenceDurationSeconds,
        input.referenceDurationSource
      ]
    )
    return this.rowToCase(result.rows[0])
  }

  public async get(id: number): Promise<UpgradeCase | null> {
    const result = await this.db.query<UpgradeCaseRow>(`SELECT ${this.columns} FROM upgrade_cases WHERE id = $1`, [id])
    const row = result.rows[0]
    return row ? this.rowToCase(row) : null
  }

  public async getByCollectionFilename(collectionFilename: string): Promise<UpgradeCase | null> {
    const result = await this.db.query<UpgradeCaseRow>(
      `SELECT ${this.columns} FROM upgrade_cases WHERE collection_filename = $1`,
      [normalizeFilename(collectionFilename)]
    )
    const row = result.rows[0]
    return row ? this.rowToCase(row) : null
  }

  public async update(id: number, patch: UpgradeCasePatch): Promise<UpgradeCase | null> {
    const parts: string[] = []
    const params: unknown[] = []

    if ('collectionFilename' in patch) {
      params.push(normalizeFilename(patch.collectionFilename ?? ''))
      parts.push(`collection_filename = $${params.length}`)
    }
    if ('status' in patch) {
      params.push(patch.status ?? 'idle')
      parts.push(`status = $${params.length}`)
    }
    if ('searchArtist' in patch) {
      params.push(normalizeText(patch.searchArtist))
      parts.push(`search_artist = $${params.length}`)
    }
    if ('searchTitle' in patch) {
      params.push(normalizeText(patch.searchTitle))
      parts.push(`search_title = $${params.length}`)
    }
    if ('searchVersion' in patch) {
      params.push(normalizeText(patch.searchVersion) || null)
      parts.push(`search_version = $${params.length}`)
    }
    if ('currentDurationSeconds' in patch) {
      params.push(patch.currentDurationSeconds ?? null)
      parts.push(`current_duration_seconds = $${params.length}`)
    }
    if ('officialDurationSeconds' in patch) {
      params.push(patch.officialDurationSeconds ?? null)
      parts.push(`official_duration_seconds = $${params.length}`)
    }
    if ('officialDurationSource' in patch) {
      params.push(patch.officialDurationSource ?? null)
      parts.push(`official_duration_source = $${params.length}`)
    }
    if ('referenceDurationSeconds' in patch) {
      params.push(patch.referenceDurationSeconds ?? null)
      parts.push(`reference_duration_seconds = $${params.length}`)
    }
    if ('referenceDurationSource' in patch) {
      params.push(patch.referenceDurationSource ?? null)
      parts.push(`reference_duration_source = $${params.length}`)
    }
    if ('candidateCacheJson' in patch) {
      params.push(patch.candidateCacheJson ?? null)
      parts.push(`candidate_cache_json = $${params.length}`)
    }
    if ('localCandidatesJson' in patch) {
      params.push(patch.localCandidatesJson ?? null)
      parts.push(`local_candidates_json = $${params.length}`)
    }
    if ('selectedCandidateJson' in patch) {
      params.push(patch.selectedCandidateJson ?? null)
      parts.push(`selected_candidate_json = $${params.length}`)
    }
    if ('selectedLocalFilename' in patch) {
      params.push(patch.selectedLocalFilename ? normalizeFilename(patch.selectedLocalFilename) : null)
      parts.push(`selected_local_filename = $${params.length}`)
    }
    if ('archiveFilename' in patch) {
      params.push(patch.archiveFilename ? normalizeFilename(patch.archiveFilename) : null)
      parts.push(`archive_filename = $${params.length}`)
    }
    if ('replacementFilename' in patch) {
      params.push(patch.replacementFilename ? normalizeFilename(patch.replacementFilename) : null)
      parts.push(`replacement_filename = $${params.length}`)
    }
    if ('lastError' in patch) {
      params.push(patch.lastError ?? null)
      parts.push(`last_error = $${params.length}`)
    }
    if ('completedAt' in patch) {
      params.push(patch.completedAt ?? null)
      parts.push(`completed_at = $${params.length}`)
    }
    if (parts.length === 0) {
      return this.get(id)
    }

    parts.push('updated_at = now()')
    params.push(id)
    const result = await this.db.query<UpgradeCaseRow>(
      `UPDATE upgrade_cases SET ${parts.join(', ')} WHERE id = $${params.length} RETURNING ${this.columns}`,
      params
    )
    const row = result.rows[0]
    return row ? this.rowToCase(row) : null
  }

  public async list(): Promise<UpgradeCase[]> {
    const result = await this.db.query<UpgradeCaseRow>(
      `SELECT ${this.columns} FROM upgrade_cases ORDER BY updated_at DESC, id DESC`
    )
    return result.rows.map((row) => this.rowToCase(row))
  }

  public async getCandidates(id: number): Promise<UpgradeCandidate[]> {
    const result = await this.db.query<{ candidate_cache_json: string | null }>(
      `SELECT candidate_cache_json FROM upgrade_cases WHERE id = $1`,
      [id]
    )
    return parseCandidates(result.rows[0]?.candidate_cache_json ?? null)
  }

  public async getLocalCandidates(id: number): Promise<UpgradeLocalCandidate[]> {
    const result = await this.db.query<{ local_candidates_json: string | null }>(
      `SELECT local_candidates_json FROM upgrade_cases WHERE id = $1`,
      [id]
    )
    return parseLocalCandidates(result.rows[0]?.local_candidates_json ?? null)
  }
}

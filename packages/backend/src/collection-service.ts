import { watch, type FSWatcher } from 'node:fs'
import { extname } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import type { AppSettings } from './settings-store'
import { AUDIO_ANALYSIS_VERSION, AUDIO_HASH_VERSION, IDENTIFY_VERSION, IMPORT_REVIEW_VERSION, LOCAL_TAG_VERSION } from '@djbrain/shared/analysis-version.ts'
import { parseImportFilename } from '@djbrain/shared/import-filename.ts'
import {
  escapeLikePattern,
  formatError,
  getDownloadFolderPrefixes,
  normalizeFilename,
  normalizeSearchText,
  recordingSourceUrlFromExternalKey,
  tokenizeSearchText,
  toListResult,
  toNumber
} from './collection-service-helpers.ts'
import {
  isDownloadRelativeFilename,
  resolveScanContext,
  scanDirectory,
  type SyncChange
} from './collection-scanner.ts'
import { listDropboxAudioFiles, readDropboxFileSourceConfig, type DropboxFileSourceConfig } from './dropbox-file-source.ts'
import { WantListStore } from './want-list-store.ts'
import { DownloadAttemptStore, type DownloadAttemptCreateInput, type DownloadAttemptPatch } from './download-attempt-store.ts'
import {
  buildExpectedDownloadFilename,
  planDownloadAttemptFileLinks,
  type DownloadAttemptFileInput,
  type DownloadAttemptFileLinkInput
} from './downloader-worker-planning.ts'
import { PROCESS_LEASE_SCHEMA_SQL, ProcessLeaseStore, type ProcessLease, type ProcessLeaseInput } from './process-lease-store.ts'
import { ensureAppSchemaVersion } from './runtime-governance.ts'
import { UpgradeCaseStore, type UpgradeCaseCreateInput, type UpgradeCasePatch } from './upgrade-case-store.ts'
import type {
  AudioAnalysis,
  CollectionItemDetails,
  FileIdentificationState,
  IdentificationAssignmentMethod,
  IdentificationCandidate,
  IdentificationStatus,
  ImportReview,
  RecordingCanonical,
  RecordingDetails,
  RecordingSummary,
  UpgradeCandidate,
  UpgradeCase,
  UpgradeLocalCandidate
} from '@djbrain/shared/api.ts'
import type { DiscogsTrackMatch } from '@djbrain/shared/discogs-match.ts'
import { compareQuality, fileQualityFromExt } from '@djbrain/shared/quality.ts'
import type {
  IdentificationDecision,
  RecordingClaimInput,
  RecordingMatchRow,
  SourceClaimMatch
} from './recording-identity-service.ts'
import { buildCanonicalNormKey, parseImportReviewClaim } from './recording-identity-service.ts'
import type { LocalSongFileState, SongsOnlySyncPlan } from './local-song-sync.ts'
import { pickImportReviewLocalMatch } from '@djbrain/shared/import-review-local-match.ts'
import { computeAnalysisQualityScore } from './audio-quality-score.ts'

type FileTagStateInput = {
  filesize: number
  mtimeMs: number
  source: string
  artist: string | null
  title: string | null
  version: string | null
  album: string | null
  year: string | null
  label: string | null
  catalogNumber: string | null
  trackPosition: string | null
  discogsReleaseId: number | null
  discogsTrackPosition: string | null
  rawJson: string | null
  errorMessage: string | null
}

export type DownloadAttemptOrigin = {
  recordingId: number | null
  artist: string | null
  title: string | null
  version: string | null
  year: string | null
  sourceCollectionFilename: string | null
}

type CollectionServiceOptions = {
  connectionString: string
  onUpdated?: (status: CollectionSyncStatus) => void
  onImportQueueChanged?: () => void
  onIdentificationQueueChanged?: () => void
  debounceMs?: number
  watchFileSystem?: boolean
}

const EMPTY_SETTINGS: AppSettings = {
  musicFolderPath: '',
  songsFolderPath: '',
  downloadFolderPaths: [],
  slskdBaseURL: '',
  slskdApiKey: '',
  discogsUserToken: '',
  grokApiKey: '',
  serperApiKey: '',
  youtubeApiKey: ''
}

const MAX_FTS_RESULTS = 500

function normalizeLimit(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null
  const normalized = Math.floor(Number(value))
  return normalized > 0 ? normalized : null
}

function normalizeTrackText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''
}

function buildImportTrackKey(review: ImportReview): string | null {
  const candidate = review.candidates[review.selectedCandidateIndex ?? 0] ?? review.candidates[0] ?? null
  if (!candidate) return null
  return [
    candidate.match.releaseId,
    normalizeTrackText(candidate.match.trackPosition),
    normalizeTrackText(candidate.match.artist),
    normalizeTrackText(candidate.match.title),
    normalizeTrackText(candidate.match.version)
  ].join(':')
}

function parseImportReview(value: string | null | undefined): ImportReview | null {
  if (!value) return null
  try {
    const review = JSON.parse(value) as ImportReview
    return review && typeof review === 'object' ? review : null
  } catch {
    return null
  }
}

export function buildDownloadExistingMatchCanonical(input: {
  filename: string
  importArtist: string | null
  importTitle: string | null
  importVersion: string | null
  importYear: string | null
}): RecordingCanonical | null {
  const cached = toCanonical(input.importArtist, input.importTitle, input.importVersion, input.importYear)
  const canonical = cached?.artist && cached.title ? cached : parseImportFilename(input.filename)
  return canonical?.artist && canonical.title ? canonical : null
}

export function buildDownloadOriginIdentificationSeed(
  origin: DownloadAttemptOrigin | null,
  parsed: { artist: string | null; title: string | null; version: string | null; year: string | null } | null
) {
  const linked = origin?.recordingId != null
  return {
    recordingId: origin?.recordingId ?? null,
    status: linked ? 'ready' as const : 'pending' as const,
    assignmentMethod: linked ? 'manual' as const : null,
    confidence: linked ? 100 : null,
    parsedArtist: origin?.artist ?? parsed?.artist ?? null,
    parsedTitle: origin?.title ?? parsed?.title ?? null,
    parsedVersion: origin?.version ?? parsed?.version ?? null,
    parsedYear: origin?.year ?? parsed?.year ?? null
  }
}

function buildFtsQuery(value: string): string {
  const terms = tokenizeSearchText(value).filter((term) => term.length >= 2)
  return terms.join(' ')
}

function buildSearchDocumentSql(...values: string[]): string {
  return `regexp_replace(concat_ws(' ', ${values.join(', ')}), '[^[:alnum:]]+', ' ', 'g')`
}

function buildAnalysisJsonSql(filenameSql: string): string {
  return [
    '(',
    `SELECT aac.analysis_json`,
    `FROM file_audio_state fas`,
    `JOIN audio_analysis_cache aac ON aac.audio_hash = fas.audio_hash`,
    `WHERE fas.filename = ${filenameSql} AND aac.analysis_json IS NOT NULL`,
    `ORDER BY aac.analysis_version DESC`,
    `LIMIT 1`,
    ')'
  ].join(' ')
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseAudioAnalysis(value: string | null | undefined): AudioAnalysis | null {
  if (!value) return null
  try {
    return JSON.parse(value) as AudioAnalysis
  } catch {
    return null
  }
}

function toCanonical(
  artist: string | null | undefined,
  title: string | null | undefined,
  version: string | null | undefined,
  year: string | null | undefined
): RecordingCanonical | null {
  return artist || title || version || year ? { artist: artist ?? null, title: title ?? null, version: version ?? null, year: year ?? null } : null
}

function normalizeJsonText(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return null
  }
}

function buildDiscogsExternalKey(match: DiscogsTrackMatch): string {
  return `discogs:release:${match.releaseId}:track:${normalizeSearchText(match.trackPosition ?? match.title) || 'unknown'}`
}

function parseDiscogsTrackMatch(value: unknown): DiscogsTrackMatch | null {
  if (!value || typeof value !== 'object') return null
  const match = value as Partial<DiscogsTrackMatch>
  return typeof match.releaseId === 'number' && typeof match.artist === 'string' && typeof match.title === 'string'
    ? {
        releaseId: match.releaseId,
        releaseTitle: match.releaseTitle ?? match.title,
        format: match.format ?? null,
        artist: match.artist,
        title: match.title,
        version: match.version ?? null,
        trackPosition: match.trackPosition ?? null,
        year: match.year ?? null,
        label: match.label ?? null,
        catalogNumber: match.catalogNumber ?? null,
        durationSeconds: match.durationSeconds ?? null,
        score: match.score ?? 100
      }
    : null
}

type PrefixWhereResult = {
  clause: string
  params: string[]
  nextParam: number
}

function buildPrefixWhereClausePg(columnName: string, prefixes: string[], startParam: number = 1): PrefixWhereResult {
  const params: string[] = []
  let index = startParam
  const clause = prefixes
    .map((prefix) => {
      params.push(prefix, `${escapeLikePattern(prefix)}/%`)
      const segment = `(${columnName} = $${index} OR ${columnName} LIKE $${index + 1} ESCAPE '\\')`
      index += 2
      return segment
    })
    .join(' OR ')
  return { clause, params, nextParam: index }
}

export type CollectionItem = {
  id: number
  filename: string
  filesize: number
  duration: number | null
  score: number | null
  isDownload?: boolean
  bitrateKbps?: number | null
  qualityScore?: number | null
  audioAnalysis?: AudioAnalysis | null
  recordingId?: number | null
  recordingDiscogsUrl?: string | null
  recordingMusicBrainzUrl?: string | null
  identificationStatus?: IdentificationStatus | null
  identificationConfidence?: number | null
  assignmentMethod?: IdentificationAssignmentMethod | null
  recordingCanonical?: RecordingCanonical | null
  importStatus?: 'pending' | 'processing' | 'ready' | 'error' | null
  importArtist?: string | null
  importTitle?: string | null
  importVersion?: string | null
  importYear?: string | null
  importError?: string | null
  importTrackKey?: string | null
  importMatchArtist?: string | null
  importMatchTitle?: string | null
  importMatchVersion?: string | null
  importMatchYear?: string | null
  importReleaseTitle?: string | null
  importTrackPosition?: string | null
  importExactExistingFilename?: string | null
  importWantListId?: number | null
  importBetterThanExisting?: boolean | null
  importExistingQualityScore?: number | null
  importQualityScore?: number | null
}

export type CollectionListResult = {
  items: CollectionItem[]
  total: number
}

export type WantListItem = {
  id: number
  wantKind: 'missing' | 'replacement'
  recordingId: number | null
  artist: string
  title: string
  version: string | null
  length: string | null
  year: string | null
  album: string | null
  label: string | null
  addedAt: string
  pipelineStatus: string
  sourceCollectionFilename: string | null
  targetDownloadCount: number
  autoDownloadEnabled: boolean
  lastSearchAt: string | null
  nextSearchAt: string | null
  selectedDownloadId: number | null
  searchId: string | null
  searchResultCount: number
  bestCandidatesJson: string | null
  downloadUsername: string | null
  downloadFilename: string | null
  pipelineError: string | null
  discogsReleaseId: number | null
  discogsTrackPosition: string | null
  discogsEntityType: string | null
  importedFilename: string | null
}

export type WantListAddInput = {
  wantKind?: 'missing' | 'replacement'
  recordingId?: number | null
  artist: string
  title: string
  version?: string | null
  length?: string | null
  year?: string | null
  album?: string | null
  label?: string | null
  discogsReleaseId?: number | null
  discogsTrackPosition?: string | null
  discogsEntityType?: string | null
  sourceCollectionFilename?: string | null
  targetDownloadCount?: number | null
  autoDownloadEnabled?: boolean | null
}

export type WantListPipelinePatch = {
  pipelineStatus?: string
  recordingId?: number | null
  sourceCollectionFilename?: string | null
  targetDownloadCount?: number
  autoDownloadEnabled?: boolean
  lastSearchAt?: string | null
  nextSearchAt?: string | null
  selectedDownloadId?: number | null
  searchId?: string | null
  searchResultCount?: number
  bestCandidatesJson?: string | null
  downloadUsername?: string | null
  downloadFilename?: string | null
  pipelineError?: string | null
  discogsReleaseId?: number | null
  discogsTrackPosition?: string | null
  importedFilename?: string | null
}

export type DownloadAttemptStatus = 'queued' | 'requested' | 'downloading' | 'downloaded' | 'failed' | 'timeout' | 'cancelled' | 'missing_local'

export type DownloadAttempt = {
  id: number
  wantListId: number | null
  status: DownloadAttemptStatus
  originRecordingId: number | null
  originArtist: string
  originTitle: string
  originVersion: string | null
  originYear: string | null
  originAlbum: string | null
  originLabel: string | null
  originSourceCollectionFilename: string | null
  originDiscogsReleaseId: number | null
  originDiscogsTrackPosition: string | null
  searchQuery: string | null
  slskdSearchId: string | null
  username: string | null
  remoteFilename: string | null
  remoteSize: number | null
  bitrate: number | null
  durationSeconds: number | null
  extension: string | null
  score: number | null
  queueLength: number | null
  hasFreeUploadSlot: boolean | null
  uploadSpeed: number | null
  isLocked: boolean
  rawCandidateJson: string | null
  expectedLocalFilename: string | null
  localFilename: string | null
  localFilesize: number | null
  errorMessage: string | null
  requestedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
  identificationPendingCount: number
  identificationProcessingCount: number
  identificationNeedsReviewCount: number
  identificationErrorCount: number
  importPendingCount: number
  importProcessingCount: number
  importErrorCount: number
  queueBackend: 'redis' | 'memory'
  queueDepth: number
  audioHashVersion: number
  audioAnalysisVersion: number
  importReviewVersion: number
}

export class CollectionService {
  private readonly pool: Pool

  private readonly wantListStore: WantListStore

  private readonly downloadAttemptStore: DownloadAttemptStore

  private readonly processLeaseStore: ProcessLeaseStore

  private readonly upgradeCaseStore: UpgradeCaseStore

  private readonly onUpdated?: (status: CollectionSyncStatus) => void

  private readonly onImportQueueChanged?: () => void

  private readonly onIdentificationQueueChanged?: () => void

  private readonly debounceMs: number

  private readonly watchFileSystem: boolean

  private readonly ready: Promise<void>

  private settings: AppSettings = { ...EMPTY_SETTINGS }

  private watchers: FSWatcher[] = []

  private debounceTimer: NodeJS.Timeout | null = null

  private disposed = false

  private pendingSync = false

  private status: CollectionSyncStatus = {
    isSyncing: false,
    lastSyncedAt: null,
    itemCount: 0,
    lastError: null,
    identificationPendingCount: 0,
    identificationProcessingCount: 0,
    identificationNeedsReviewCount: 0,
    identificationErrorCount: 0,
    importPendingCount: 0,
    importProcessingCount: 0,
    importErrorCount: 0,
    queueBackend: 'memory',
    queueDepth: 0,
    audioHashVersion: AUDIO_HASH_VERSION,
    audioAnalysisVersion: AUDIO_ANALYSIS_VERSION,
    importReviewVersion: IMPORT_REVIEW_VERSION
  }

  constructor(options: CollectionServiceOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, max: 8 })
    this.wantListStore = new WantListStore(this.pool)
    this.downloadAttemptStore = new DownloadAttemptStore(this.pool)
    this.processLeaseStore = new ProcessLeaseStore(this.pool)
    this.upgradeCaseStore = new UpgradeCaseStore(this.pool)
    this.onUpdated = options.onUpdated
    this.onImportQueueChanged = options.onImportQueueChanged
    this.onIdentificationQueueChanged = options.onIdentificationQueueChanged
    this.debounceMs = options.debounceMs ?? 750
    this.watchFileSystem = options.watchFileSystem ?? true
    this.ready = this.initializeSchema().then(async () => {
      this.status.itemCount = await this.readItemCount()
      await this.refreshImportQueueCounts()
      await this.refreshIdentificationQueueCounts()
    })
  }

  private async ensureReady(): Promise<void> {
    await this.ready
  }

  private async ensureSchemaVersion(write: boolean = true): Promise<void> {
    await ensureAppSchemaVersion(this.pool, write)
  }

  public async reconfigure(settings: AppSettings): Promise<void> {
    await this.ensureReady()
    this.settings = {
      musicFolderPath: settings.musicFolderPath,
      songsFolderPath: settings.songsFolderPath,
      downloadFolderPaths: [...settings.downloadFolderPaths],
      slskdBaseURL: settings.slskdBaseURL,
      slskdApiKey: settings.slskdApiKey,
      discogsUserToken: settings.discogsUserToken,
      grokApiKey: settings.grokApiKey,
      serperApiKey: settings.serperApiKey,
      youtubeApiKey: settings.youtubeApiKey
    }
    if (this.watchFileSystem) await this.restartWatchers()
    else this.closeWatchers()
  }

  public getStatus(): CollectionSyncStatus {
    return { ...this.status }
  }

  public setQueueStatus(queueBackend: 'redis' | 'memory', queueDepth: number): void {
    this.status.queueBackend = queueBackend
    this.status.queueDepth = queueDepth
    this.emitStatus()
  }

  public async list(query: string = '', limit?: number): Promise<CollectionListResult> {
    await this.ensureReady()
    const normalizedLimit = normalizeLimit(limit)
    const ftsQuery = buildFtsQuery(query)
    type ListRow = {
      id: number | bigint
      filename: string
      filesize: number | bigint
      score: number | null
      analysisjson: string | null
      recordingid: number | bigint | null
      recordingdiscogsexternalkey: string | null
      recordingmusicbrainzexternalkey: string | null
      identificationstatus: IdentificationStatus | null
      identificationconfidence: number | null
      assignmentmethod: IdentificationAssignmentMethod | null
      recordingcanonicalartist: string | null
      recordingcanonicaltitle: string | null
      recordingcanonicalversion: string | null
      recordingcanonicalyear: string | null
    }
    const searchDocumentSql = buildSearchDocumentSql(
      'collection_files.filename',
      'recordings.canonical_artist',
      'recordings.canonical_title',
      'recordings.canonical_version',
      'recordings.canonical_year'
    )
    const selectSql = `
      SELECT
        collection_files.filename AS filename,
        collection_files.id AS id,
        collection_files.filesize AS filesize,
        ${ftsQuery ? `ts_rank_cd(to_tsvector('simple', ${searchDocumentSql}), plainto_tsquery('simple', $1))` : 'NULL'} AS score,
        ${buildAnalysisJsonSql('collection_files.filename')} AS analysisJson,
        file_identification_state.recording_id AS recordingId,
        (
          SELECT external_key
          FROM recording_source_claims
          WHERE recording_id = recordings.id AND provider = 'discogs'
          ORDER BY confidence DESC, id
          LIMIT 1
        ) AS recordingDiscogsExternalKey,
        (
          SELECT external_key
          FROM recording_source_claims
          WHERE recording_id = recordings.id AND provider = 'musicbrainz'
          ORDER BY confidence DESC, id
          LIMIT 1
        ) AS recordingMusicBrainzExternalKey,
        file_identification_state.status AS identificationStatus,
        file_identification_state.confidence AS identificationConfidence,
        file_identification_state.assignment_method AS assignmentMethod,
        recordings.canonical_artist AS recordingCanonicalArtist,
        recordings.canonical_title AS recordingCanonicalTitle,
        recordings.canonical_version AS recordingCanonicalVersion,
        recordings.canonical_year AS recordingCanonicalYear
      FROM collection_files
      LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
      LEFT JOIN recordings ON recordings.id = file_identification_state.recording_id
    `

    if (!ftsQuery) {
      const values = normalizedLimit ? [normalizedLimit] : []
      const limitSql = normalizedLimit ? 'LIMIT $1::int' : ''
      const result = await this.pool.query<ListRow>(selectSql + ` ORDER BY lower(collection_files.filename) ${limitSql}`, values)
      return toListResult(
        result.rows.map((row) => {
          const analysis = parseAudioAnalysis(row.analysisjson)
          return {
            filename: row.filename,
            id: toNumber(row.id),
            filesize: row.filesize,
            duration: analysis?.durationSeconds ?? null,
            score: row.score,
            isDownload: isDownloadRelativeFilename(row.filename, this.settings.downloadFolderPaths),
            bitrateKbps: analysis?.bitrateKbps ?? null,
            qualityScore: computeAnalysisQualityScore(analysis),
            recordingId: row.recordingid,
            recordingDiscogsUrl: recordingSourceUrlFromExternalKey(row.recordingdiscogsexternalkey),
            recordingMusicBrainzUrl: recordingSourceUrlFromExternalKey(row.recordingmusicbrainzexternalkey),
            identificationStatus: row.identificationstatus,
            identificationConfidence: row.identificationconfidence,
            assignmentMethod: row.assignmentmethod,
            recordingCanonicalArtist: row.recordingcanonicalartist,
            recordingCanonicalTitle: row.recordingcanonicaltitle,
            recordingCanonicalVersion: row.recordingcanonicalversion,
            recordingCanonicalYear: row.recordingcanonicalyear
          }
        })
      )
    }

    const result = await this.pool.query<ListRow>(
      selectSql +
        `
        WHERE to_tsvector('simple', ${searchDocumentSql}) @@ plainto_tsquery('simple', $1)
        ORDER BY score DESC, lower(collection_files.filename)
        LIMIT $2::int
      `,
      [ftsQuery, normalizedLimit ?? MAX_FTS_RESULTS]
    )
    return toListResult(
      result.rows.map((row) => {
        const analysis = parseAudioAnalysis(row.analysisjson)
        return {
          filename: row.filename,
          id: toNumber(row.id),
          filesize: row.filesize,
          duration: analysis?.durationSeconds ?? null,
          score: row.score,
          isDownload: isDownloadRelativeFilename(row.filename, this.settings.downloadFolderPaths),
          bitrateKbps: analysis?.bitrateKbps ?? null,
          qualityScore: computeAnalysisQualityScore(analysis),
          recordingId: row.recordingid,
          recordingDiscogsUrl: recordingSourceUrlFromExternalKey(row.recordingdiscogsexternalkey),
          recordingMusicBrainzUrl: recordingSourceUrlFromExternalKey(row.recordingmusicbrainzexternalkey),
          identificationStatus: row.identificationstatus,
          identificationConfidence: row.identificationconfidence,
          assignmentMethod: row.assignmentmethod,
          recordingCanonicalArtist: row.recordingcanonicalartist,
          recordingCanonicalTitle: row.recordingcanonicaltitle,
          recordingCanonicalVersion: row.recordingcanonicalversion,
          recordingCanonicalYear: row.recordingcanonicalyear
        }
      })
    )
  }

  public async getItem(filename: string): Promise<CollectionItemDetails | null> {
    await this.ensureReady()
    const itemResult = await this.pool.query<{
      id: number | bigint
      filename: string
      filesize: number | bigint
      mtimems: number | bigint | null
      recordingid: number | bigint | null
      identificationstatus: IdentificationStatus | null
      identificationconfidence: number | null
      assignmentmethod: IdentificationAssignmentMethod | null
      recordingcanonicalartist: string | null
      recordingcanonicaltitle: string | null
      recordingcanonicalversion: string | null
      recordingcanonicalyear: string | null
    }>(
      `
        SELECT
          collection_files.filename,
          collection_files.id,
          collection_files.filesize,
          collection_file_state.mtime_ms AS mtimeMs,
          file_identification_state.recording_id AS recordingId,
          file_identification_state.status AS identificationStatus,
          file_identification_state.confidence AS identificationConfidence,
          file_identification_state.assignment_method AS assignmentMethod,
          recordings.canonical_artist AS recordingCanonicalArtist,
          recordings.canonical_title AS recordingCanonicalTitle,
          recordings.canonical_version AS recordingCanonicalVersion,
          recordings.canonical_year AS recordingCanonicalYear
        FROM collection_files
        LEFT JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
        LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
        LEFT JOIN recordings ON recordings.id = file_identification_state.recording_id
        WHERE collection_files.filename = $1
      `,
      [filename]
    )
    const itemRow = itemResult.rows[0]
    if (!itemRow) return null

    const importResult = await this.pool.query<{
      filesize: number | bigint
      mtimems: number | bigint
      reviewversion: number | bigint
      status: 'pending' | 'processing' | 'ready' | 'error'
      parsedartist: string | null
      parsedtitle: string | null
      parsedversion: string | null
      parsedyear: string | null
      reviewjson: string | null
      errormessage: string | null
      processedat: Date | string | null
    }>(
      `
        SELECT
          filesize,
          mtime_ms AS mtimeMs,
          review_version AS reviewVersion,
          status,
          parsed_artist AS parsedArtist,
          parsed_title AS parsedTitle,
          parsed_version AS parsedVersion,
          parsed_year AS parsedYear,
          review_json AS reviewJson,
          error_message AS errorMessage,
          processed_at AS processedAt
        FROM import_review_cache
        WHERE filename = $1
      `,
      [filename]
    )
    const importRow = importResult.rows[0]

    const fileTagRow = (
      await this.pool.query<{
        source: string
        artist: string | null
        title: string | null
        version: string | null
        album: string | null
        year: string | null
        label: string | null
        catalognumber: string | null
        trackposition: string | null
        discogsreleaseid: number | bigint | null
        discogstrackposition: string | null
      }>(
        `
          SELECT
            source,
            artist,
            title,
            version,
            album,
            year,
            label,
            catalog_number AS catalogNumber,
            track_position AS trackPosition,
            discogs_release_id AS discogsReleaseId,
            discogs_track_position AS discogsTrackPosition
          FROM file_tag_state
          WHERE filename = $1
        `,
        [filename]
      )
    ).rows[0]

    const fileAudioResult = await this.pool.query<{
      filesize: number | bigint
      mtimems: number | bigint
      hashversion: number | bigint
      audiohash: string | null
      status: 'pending' | 'ready' | 'error'
      errormessage: string | null
      processedat: Date | string | null
    }>(
      `
        SELECT
          filesize,
          mtime_ms AS mtimeMs,
          hash_version AS hashVersion,
          audio_hash AS audioHash,
          status,
          error_message AS errorMessage,
          processed_at AS processedAt
        FROM file_audio_state
        WHERE filename = $1
      `,
      [filename]
    )
    const fileAudioRow = fileAudioResult.rows[0]

    const audioAnalysisRow = fileAudioRow?.audiohash
      ? (
          await this.pool.query<{
            audiohash: string
            analysisversion: number | bigint
            analysisjson: string | null
            errormessage: string | null
            processedat: Date | string | null
          }>(
            `
              SELECT
                audio_hash AS audioHash,
                analysis_version AS analysisVersion,
                analysis_json AS analysisJson,
                error_message AS errorMessage,
                processed_at AS processedAt
              FROM audio_analysis_cache
              WHERE audio_hash = $1
              ORDER BY analysis_version DESC
              LIMIT 1
            `,
            [fileAudioRow.audiohash]
          )
        ).rows[0]
      : undefined

    let parsedAudioAnalysis: AudioAnalysis | null = null
    if (audioAnalysisRow?.analysisjson) {
      try {
        parsedAudioAnalysis = JSON.parse(audioAnalysisRow.analysisjson) as AudioAnalysis
      } catch {
        parsedAudioAnalysis = null
      }
    }

    const identificationRow = (
      await this.pool.query<{
        recordingid: number | bigint | null
        audiohash: string | null
        status: IdentificationStatus
        assignmentmethod: IdentificationAssignmentMethod | null
        confidence: number | null
        parsedartist: string | null
        parsedtitle: string | null
        parsedversion: string | null
        parsedyear: string | null
        tagartist: string | null
        tagtitle: string | null
        tagversion: string | null
        chosenclaimid: number | bigint | null
        identifyversion: number | bigint
        explanationjson: unknown | null
        verifiedat: Date | string | null
        processedat: Date | string | null
        errormessage: string | null
      }>(
        `
          SELECT
            recording_id AS recordingId,
            audio_hash AS audioHash,
            status,
            assignment_method AS assignmentMethod,
            confidence,
            parsed_artist AS parsedArtist,
            parsed_title AS parsedTitle,
            parsed_version AS parsedVersion,
            parsed_year AS parsedYear,
            tag_artist AS tagArtist,
            tag_title AS tagTitle,
            tag_version AS tagVersion,
            chosen_claim_id AS chosenClaimId,
            identify_version AS identifyVersion,
            explanation_json AS explanationJson,
            verified_at AS verifiedAt,
            processed_at AS processedAt,
            error_message AS errorMessage
          FROM file_identification_state
          WHERE filename = $1
        `,
        [filename]
      )
    ).rows[0]

    const identificationCandidates = identificationRow
      ? (
          await this.pool.query<{
            id: number | bigint
            provider: IdentificationCandidate['provider']
            entitytype: IdentificationCandidate['entityType']
            externalkey: string
            proposedrecordingid: number | bigint | null
            score: number
            disposition: IdentificationCandidate['disposition']
            payloadjson: unknown | null
            recordingcanonicalartist: string | null
            recordingcanonicaltitle: string | null
            recordingcanonicalversion: string | null
            recordingcanonicalyear: string | null
          }>(
            `
              SELECT
                file_identification_candidates.id,
                file_identification_candidates.provider,
                file_identification_candidates.entity_type AS entityType,
                file_identification_candidates.external_key AS externalKey,
                file_identification_candidates.proposed_recording_id AS proposedRecordingId,
                file_identification_candidates.score,
                file_identification_candidates.disposition,
                file_identification_candidates.payload_json AS payloadJson,
                recordings.canonical_artist AS recordingCanonicalArtist,
                recordings.canonical_title AS recordingCanonicalTitle,
                recordings.canonical_version AS recordingCanonicalVersion,
                recordings.canonical_year AS recordingCanonicalYear
              FROM file_identification_candidates
              LEFT JOIN recordings ON recordings.id = file_identification_candidates.proposed_recording_id
              WHERE file_identification_candidates.filename = $1
              ORDER BY file_identification_candidates.score DESC, file_identification_candidates.id
            `,
            [filename]
          )
        ).rows.map((row) => ({
          id: toNumber(row.id),
          filename,
          provider: row.provider,
          entityType: row.entitytype,
          externalKey: row.externalkey,
          proposedRecordingId: row.proposedrecordingid == null ? null : toNumber(row.proposedrecordingid),
          score: row.score,
          disposition: row.disposition,
          payloadJson: row.payloadjson == null ? null : JSON.stringify(row.payloadjson),
          recordingCanonical: toCanonical(
            row.recordingcanonicalartist,
            row.recordingcanonicaltitle,
            row.recordingcanonicalversion,
            row.recordingcanonicalyear
          )
        }))
      : []

    const recordingCanonical = toCanonical(
      itemRow.recordingcanonicalartist,
      itemRow.recordingcanonicaltitle,
      itemRow.recordingcanonicalversion,
      itemRow.recordingcanonicalyear
    )
    const identification: FileIdentificationState | null = identificationRow
      ? {
          filename,
          recordingId: identificationRow.recordingid == null ? null : toNumber(identificationRow.recordingid),
          audioHash: identificationRow.audiohash,
          status: identificationRow.status,
          assignmentMethod: identificationRow.assignmentmethod,
          confidence: identificationRow.confidence,
          parsedArtist: identificationRow.parsedartist,
          parsedTitle: identificationRow.parsedtitle,
          parsedVersion: identificationRow.parsedversion,
          parsedYear: identificationRow.parsedyear,
          tagArtist: identificationRow.tagartist,
          tagTitle: identificationRow.tagtitle,
          tagVersion: identificationRow.tagversion,
          chosenClaimId: identificationRow.chosenclaimid == null ? null : toNumber(identificationRow.chosenclaimid),
          identifyVersion: toNumber(identificationRow.identifyversion),
          explanationJson: identificationRow.explanationjson == null ? null : JSON.stringify(identificationRow.explanationjson),
          verifiedAt: toIso(identificationRow.verifiedat),
          processedAt: toIso(identificationRow.processedat),
          errorMessage: identificationRow.errormessage,
          recordingCanonical,
          candidates: identificationCandidates
        }
      : null

    return {
      filename: itemRow.filename,
      id: toNumber(itemRow.id),
      filesize: toNumber(itemRow.filesize),
      mtimeMs: itemRow.mtimems == null ? null : toNumber(itemRow.mtimems),
      isDownload: isDownloadRelativeFilename(itemRow.filename, this.settings.downloadFolderPaths),
      recordingId: itemRow.recordingid == null ? null : toNumber(itemRow.recordingid),
      identificationStatus: itemRow.identificationstatus ?? null,
      identificationConfidence: itemRow.identificationconfidence ?? null,
      assignmentMethod: itemRow.assignmentmethod ?? null,
      identificationVerifiedAt: identification?.verifiedAt ?? null,
      recordingCanonical,
      tags: fileTagRow
        ? {
            source: fileTagRow.source || 'file_tag_state',
            artist: fileTagRow.artist,
            title: fileTagRow.title,
            version: fileTagRow.version,
            album: fileTagRow.album,
            year: fileTagRow.year,
            label: fileTagRow.label,
            catalogNumber: fileTagRow.catalognumber,
            trackPosition: fileTagRow.trackposition,
            discogsReleaseId: fileTagRow.discogsreleaseid == null ? null : toNumber(fileTagRow.discogsreleaseid),
            discogsTrackPosition: fileTagRow.discogstrackposition
          }
        : importRow
        ? {
            source: 'import_review_cache',
            artist: importRow.parsedartist ?? null,
            title: importRow.parsedtitle ?? null,
            version: importRow.parsedversion ?? null,
            album: null,
            year: importRow.parsedyear ?? null,
            label: null,
            catalogNumber: null,
            trackPosition: null,
            discogsReleaseId: null,
            discogsTrackPosition: null
          }
        : null,
      importReview: importRow
        ? {
            filesize: toNumber(importRow.filesize),
            mtimeMs: toNumber(importRow.mtimems),
            reviewVersion: toNumber(importRow.reviewversion),
            status: importRow.status,
            parsedArtist: importRow.parsedartist,
            parsedTitle: importRow.parsedtitle,
            parsedVersion: importRow.parsedversion,
            parsedYear: importRow.parsedyear,
            reviewJson: importRow.reviewjson,
            errorMessage: importRow.errormessage,
            processedAt: toIso(importRow.processedat)
          }
        : null,
      fileAudioState: fileAudioRow
        ? {
            filesize: toNumber(fileAudioRow.filesize),
            mtimeMs: toNumber(fileAudioRow.mtimems),
            hashVersion: toNumber(fileAudioRow.hashversion),
            audioHash: fileAudioRow.audiohash,
            status: fileAudioRow.status,
            errorMessage: fileAudioRow.errormessage,
            processedAt: toIso(fileAudioRow.processedat)
          }
        : null,
      audioAnalysisCache: audioAnalysisRow
        ? {
            audioHash: audioAnalysisRow.audiohash,
            analysisVersion: toNumber(audioAnalysisRow.analysisversion),
            analysisJson: audioAnalysisRow.analysisjson,
            errorMessage: audioAnalysisRow.errormessage,
            processedAt: toIso(audioAnalysisRow.processedat)
          }
        : null,
      qualityScore: computeAnalysisQualityScore(parsedAudioAnalysis),
      parsedAudioAnalysis,
      identification,
      upgradeCase: await this.upgradeCaseGetByCollectionFilename(itemRow.filename)
    }
  }

  public async listDownloads(query: string = ''): Promise<CollectionListResult> {
    await this.ensureReady()
    const prefixes = getDownloadFolderPrefixes(this.settings.downloadFolderPaths)
    if (prefixes.length === 0) {
      return { items: [], total: 0 }
    }

    const { clause, params, nextParam } = buildPrefixWhereClausePg('collection_files.filename', prefixes)
    const ftsQuery = buildFtsQuery(query)
    const values: unknown[] = [...params]
    const searchDocumentSql = buildSearchDocumentSql(
      'collection_files.filename',
      'recordings.canonical_artist',
      'recordings.canonical_title',
      'recordings.canonical_version',
      'recordings.canonical_year',
      'import_review_cache.parsed_artist',
      'import_review_cache.parsed_title',
      'import_review_cache.parsed_version',
      'import_review_cache.parsed_year'
    )

    const scoreSql = ftsQuery
      ? `ts_rank_cd(to_tsvector('simple', ${searchDocumentSql}), plainto_tsquery('simple', $${nextParam}))`
      : 'NULL'
    let whereSql = clause
    if (ftsQuery) {
      values.push(ftsQuery)
      whereSql += ` AND to_tsvector('simple', ${searchDocumentSql}) @@ plainto_tsquery('simple', $${nextParam})`
    }
    if (ftsQuery) {
      values.push(MAX_FTS_RESULTS)
    }

    const rows = (
      await this.pool.query<{
        id: number | bigint
        filename: string
        filesize: number | bigint
        score: number | null
        recordingid: number | bigint | null
        recordingdiscogsexternalkey: string | null
        recordingmusicbrainzexternalkey: string | null
        identificationstatus: CollectionItem['identificationStatus']
        identificationconfidence: number | null
        assignmentmethod: CollectionItem['assignmentMethod']
        recordingcanonicalartist: string | null
        recordingcanonicaltitle: string | null
        recordingcanonicalversion: string | null
        recordingcanonicalyear: string | null
        importstatus: CollectionItem['importStatus']
        importartist: string | null
        importtitle: string | null
        importversion: string | null
        importyear: string | null
        importerror: string | null
        importreviewjson: string | null
        downloadoriginwantlistid: number | bigint | null
        downloadoriginsourcecollectionfilename: string | null
      }>(
        `
          SELECT
            collection_files.id AS id,
            collection_files.filename AS filename,
            collection_files.filesize AS filesize,
            ${scoreSql} AS score,
            COALESCE(file_identification_state.recording_id, download_origin.originRecordingId) AS recordingId,
            (
              SELECT external_key
              FROM recording_source_claims
              WHERE recording_id = recordings.id AND provider = 'discogs'
              ORDER BY confidence DESC, id
              LIMIT 1
            ) AS recordingDiscogsExternalKey,
            (
              SELECT external_key
              FROM recording_source_claims
              WHERE recording_id = recordings.id AND provider = 'musicbrainz'
              ORDER BY confidence DESC, id
              LIMIT 1
            ) AS recordingMusicBrainzExternalKey,
            COALESCE(file_identification_state.status, CASE WHEN download_origin.originRecordingId IS NULL THEN NULL ELSE 'ready' END) AS identificationStatus,
            COALESCE(file_identification_state.confidence, CASE WHEN download_origin.originRecordingId IS NULL THEN NULL ELSE 100 END) AS identificationConfidence,
            COALESCE(file_identification_state.assignment_method, CASE WHEN download_origin.originRecordingId IS NULL THEN NULL ELSE 'manual' END) AS assignmentMethod,
            recordings.canonical_artist AS recordingCanonicalArtist,
            recordings.canonical_title AS recordingCanonicalTitle,
            recordings.canonical_version AS recordingCanonicalVersion,
            recordings.canonical_year AS recordingCanonicalYear,
            import_review_cache.status AS importStatus,
            import_review_cache.parsed_artist AS importArtist,
            import_review_cache.parsed_title AS importTitle,
            import_review_cache.parsed_version AS importVersion,
            import_review_cache.parsed_year AS importYear,
            import_review_cache.error_message AS importError,
            import_review_cache.review_json AS importReviewJson,
            download_origin.wantListId AS downloadOriginWantListId,
            download_origin.originSourceCollectionFilename AS downloadOriginSourceCollectionFilename
          FROM collection_files
          LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
          LEFT JOIN import_review_cache ON import_review_cache.filename = collection_files.filename
          LEFT JOIN LATERAL (
            SELECT
              download_attempts.want_list_id AS wantListId,
              COALESCE(download_attempts.origin_recording_id, want_list.recording_id) AS originRecordingId,
              COALESCE(download_attempts.origin_source_collection_filename, want_list.source_collection_filename) AS originSourceCollectionFilename
            FROM download_attempts
            LEFT JOIN want_list ON want_list.id = download_attempts.want_list_id
            WHERE download_attempts.local_filename = collection_files.filename
            ORDER BY download_attempts.completed_at DESC NULLS LAST, download_attempts.updated_at DESC, download_attempts.id DESC
            LIMIT 1
          ) download_origin ON TRUE
          LEFT JOIN recordings ON recordings.id = COALESCE(file_identification_state.recording_id, download_origin.originRecordingId)
          WHERE ${whereSql}
          ORDER BY ${ftsQuery ? 'score DESC,' : ''} lower(collection_files.filename)
          ${ftsQuery ? `LIMIT $${nextParam + 1}::int` : ''}
        `,
        values
      )
    ).rows

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const review = parseImportReview(row.importreviewjson)
        const candidate = review?.candidates[review.selectedCandidateIndex ?? 0] ?? review?.candidates[0] ?? null
        const localMatch = pickImportReviewLocalMatch(review)
        const parsedExistingFilename = candidate || localMatch
          ? null
          : await this.findExistingCollectionFilenameByCanonical(buildDownloadExistingMatchCanonical({
              filename: row.filename,
              importArtist: row.importartist,
              importTitle: row.importtitle,
              importVersion: row.importversion,
              importYear: row.importyear
            }), prefixes)
        const localCanonical = localMatch?.recordingCanonical ?? null
        const existingFilename = row.downloadoriginsourcecollectionfilename ?? candidate?.exactExistingFilename ?? localMatch?.filename ?? parsedExistingFilename
        const sourceFilesize = toNumber(row.filesize)
        const sourceAnalysis = await this.readCachedAudioAnalysisByFilename(row.filename)
        const sourceQuality = await this.readFileQuality(row.filename, sourceFilesize)
        const existingFilesize = existingFilename
          ? await this.readCollectionFilesize(existingFilename)
          : null
        const existingAnalysis = existingFilename
          ? await this.readCachedAudioAnalysisByFilename(existingFilename)
          : null
        const existingQuality = existingFilename
          ? await this.readFileQuality(existingFilename, existingFilesize)
          : null
        const sourceAnalysisQualityScore = computeAnalysisQualityScore(sourceAnalysis)
        const existingAnalysisQualityScore = computeAnalysisQualityScore(existingAnalysis)

        return {
          ...row,
          id: toNumber(row.id),
          isDownload: true,
          duration: sourceAnalysis?.durationSeconds ?? null,
          bitrateKbps: sourceAnalysis?.bitrateKbps ?? null,
          qualityScore: sourceAnalysisQualityScore,
          audioAnalysis: sourceAnalysis,
          recordingId: row.recordingid == null ? null : toNumber(row.recordingid),
          recordingDiscogsUrl: recordingSourceUrlFromExternalKey(row.recordingdiscogsexternalkey),
          recordingMusicBrainzUrl: recordingSourceUrlFromExternalKey(row.recordingmusicbrainzexternalkey),
          identificationStatus: row.identificationstatus ?? null,
          identificationConfidence: row.identificationconfidence ?? null,
          assignmentMethod: row.assignmentmethod ?? null,
          recordingCanonicalArtist: row.recordingcanonicalartist,
          recordingCanonicalTitle: row.recordingcanonicaltitle,
          recordingCanonicalVersion: row.recordingcanonicalversion,
          recordingCanonicalYear: row.recordingcanonicalyear,
          importStatus: row.importstatus,
          importArtist: row.importartist,
          importTitle: row.importtitle,
          importVersion: row.importversion,
          importYear: row.importyear,
          importError: row.importerror,
          importTrackKey: review ? buildImportTrackKey(review) : null,
          importMatchArtist: candidate?.match.artist ?? localCanonical?.artist ?? null,
          importMatchTitle: candidate?.match.title ?? localCanonical?.title ?? null,
          importMatchVersion: candidate?.match.version ?? localCanonical?.version ?? null,
          importMatchYear: candidate?.match.year ?? localCanonical?.year ?? null,
          importReleaseTitle: candidate?.match.releaseTitle ?? null,
          importTrackPosition: candidate?.match.trackPosition ?? null,
          importExactExistingFilename: existingFilename,
          importWantListId: row.downloadoriginwantlistid == null ? null : toNumber(row.downloadoriginwantlistid),
          importBetterThanExisting:
            !sourceQuality || !existingQuality ? null : compareQuality(sourceQuality, existingQuality) === 'better',
          importExistingQualityScore: existingAnalysisQualityScore,
          importQualityScore: sourceAnalysisQualityScore
        }
      })
    )

    return toListResult(enriched)
  }

  public async syncNow(): Promise<CollectionSyncStatus> {
    await this.ensureReady()
    if (this.disposed) {
      return this.getStatus()
    }

    if (this.status.isSyncing) {
      this.pendingSync = true
      return this.getStatus()
    }

    this.status.isSyncing = true
    this.emitStatus()

    try {
      do {
        this.pendingSync = false
        const warning = await this.runSyncPass()
        this.status.lastError = warning
        if (!warning) {
          this.status.lastSyncedAt = nowIso()
        }
      } while (this.pendingSync && !this.disposed)
    } catch (error) {
      this.status.lastError = formatError(error)
    } finally {
      this.status.isSyncing = false
      this.emitStatus()
    }

    return this.getStatus()
  }

  public dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.closeWatchers()

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    void this.pool.end()
  }

  private async initializeSchema(): Promise<void> {
    await this.ensureSchemaVersion(false)
    await this.pool.query(`
      ${PROCESS_LEASE_SCHEMA_SQL}

      CREATE TABLE IF NOT EXISTS collection_files (
        id BIGINT,
        filename TEXT PRIMARY KEY,
        filesize BIGINT NOT NULL
      );

      CREATE SEQUENCE IF NOT EXISTS collection_files_id_seq;
      ALTER TABLE collection_files ADD COLUMN IF NOT EXISTS id BIGINT;
      ALTER TABLE collection_files ALTER COLUMN id SET DEFAULT nextval('collection_files_id_seq');
      UPDATE collection_files SET id = nextval('collection_files_id_seq') WHERE id IS NULL;
      SELECT setval('collection_files_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM collection_files), 1), true);
      ALTER TABLE collection_files ALTER COLUMN id SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS collection_files_id_key ON collection_files(id);

      CREATE TABLE IF NOT EXISTS collection_file_state (
        filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
        mtime_ms BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS import_review_cache (
        filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        review_version INTEGER NOT NULL DEFAULT ${IMPORT_REVIEW_VERSION},
        status TEXT NOT NULL DEFAULT 'pending',
        parsed_artist TEXT,
        parsed_title TEXT,
        parsed_version TEXT,
        parsed_year TEXT,
        review_json TEXT,
        error_message TEXT,
        processed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS import_review_cache_status_idx
      ON import_review_cache(status, processed_at, filename);

      CREATE TABLE IF NOT EXISTS file_audio_state (
        filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        hash_version INTEGER NOT NULL,
        audio_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        processed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS file_audio_state_status_idx
      ON file_audio_state(status, processed_at, filename);

      CREATE TABLE IF NOT EXISTS file_tag_state (
        filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        tag_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        artist TEXT,
        title TEXT,
        version TEXT,
        album TEXT,
        year TEXT,
        label TEXT,
        catalog_number TEXT,
        track_position TEXT,
        discogs_release_id BIGINT,
        discogs_track_position TEXT,
        raw_json JSONB,
        error_message TEXT,
        processed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS audio_analysis_cache (
        audio_hash TEXT NOT NULL,
        analysis_version INTEGER NOT NULL,
        analysis_json TEXT,
        error_message TEXT,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY(audio_hash, analysis_version)
      );

      CREATE TABLE IF NOT EXISTS recordings (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        canonical_artist TEXT,
        canonical_title TEXT,
        canonical_version TEXT,
        canonical_year TEXT,
        canonical_norm_key TEXT,
        duration_seconds DOUBLE PRECISION,
        confidence INTEGER NOT NULL DEFAULT 0,
        review_state TEXT NOT NULL DEFAULT 'auto',
        metadata_locked BOOLEAN NOT NULL DEFAULT FALSE,
        merged_into_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS recordings_canonical_norm_key_idx
      ON recordings(canonical_norm_key);

      CREATE TABLE IF NOT EXISTS audio_assets (
        audio_hash TEXT PRIMARY KEY,
        recording_id BIGINT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        duration_seconds DOUBLE PRECISION,
        assigned_by TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS recording_source_claims (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        recording_id BIGINT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_key TEXT NOT NULL,
        artist TEXT,
        title TEXT,
        version TEXT,
        release_title TEXT,
        track_position TEXT,
        year TEXT,
        duration_seconds DOUBLE PRECISION,
        confidence INTEGER NOT NULL DEFAULT 0,
        raw_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(provider, entity_type, external_key)
      );

      CREATE INDEX IF NOT EXISTS recording_source_claims_recording_idx
      ON recording_source_claims(recording_id);

      CREATE TABLE IF NOT EXISTS file_identification_state (
        filename TEXT PRIMARY KEY REFERENCES collection_files(filename) ON DELETE CASCADE,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
        audio_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        assignment_method TEXT,
        confidence INTEGER,
        parsed_artist TEXT,
        parsed_title TEXT,
        parsed_version TEXT,
        parsed_year TEXT,
        tag_artist TEXT,
        tag_title TEXT,
        tag_version TEXT,
        chosen_claim_id BIGINT REFERENCES recording_source_claims(id) ON DELETE SET NULL,
        identify_version INTEGER NOT NULL DEFAULT ${IDENTIFY_VERSION},
        explanation_json JSONB,
        verified_at TIMESTAMPTZ,
        error_message TEXT,
        processed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS file_identification_state_status_idx
      ON file_identification_state(status, processed_at, filename);

      CREATE TABLE IF NOT EXISTS file_identification_candidates (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        filename TEXT NOT NULL REFERENCES collection_files(filename) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_key TEXT NOT NULL,
        proposed_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
        score INTEGER NOT NULL,
        disposition TEXT NOT NULL DEFAULT 'candidate',
        payload_json JSONB,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS file_identification_candidates_filename_idx
      ON file_identification_candidates(filename, score DESC, id);

      CREATE TABLE IF NOT EXISTS file_identification_archive (
        filename TEXT PRIMARY KEY,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        recording_id BIGINT,
        audio_hash TEXT,
        status TEXT NOT NULL,
        assignment_method TEXT,
        confidence INTEGER,
        parsed_artist TEXT,
        parsed_title TEXT,
        parsed_version TEXT,
        parsed_year TEXT,
        tag_artist TEXT,
        tag_title TEXT,
        tag_version TEXT,
        chosen_claim_id BIGINT,
        identify_version INTEGER NOT NULL,
        explanation_json JSONB,
        verified_at TIMESTAMPTZ,
        error_message TEXT,
        processed_at TIMESTAMPTZ,
        candidates_json JSONB,
        archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS collection_files_filename_lower_idx
      ON collection_files((lower(filename)));

      CREATE INDEX IF NOT EXISTS collection_files_search_idx
      ON collection_files USING GIN (to_tsvector('simple', filename));

      CREATE TABLE IF NOT EXISTS want_list (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        want_kind TEXT NOT NULL DEFAULT 'missing',
        recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT,
        length TEXT,
        year TEXT,
        album TEXT,
        label TEXT,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        pipeline_status TEXT NOT NULL DEFAULT 'idle',
        source_collection_filename TEXT,
        target_download_count INTEGER NOT NULL DEFAULT 3,
        auto_download_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_search_at TIMESTAMPTZ,
        next_search_at TIMESTAMPTZ,
        selected_download_id BIGINT,
        search_id TEXT,
        search_result_count INTEGER NOT NULL DEFAULT 0,
        best_candidates_json TEXT,
        download_username TEXT,
        download_filename TEXT,
        pipeline_error TEXT,
        discogs_release_id BIGINT,
        discogs_track_position TEXT,
        discogs_entity_type TEXT,
        imported_filename TEXT
      );

      CREATE TABLE IF NOT EXISTS upgrade_cases (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        collection_filename TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'idle',
        search_artist TEXT NOT NULL,
        search_title TEXT NOT NULL,
        search_version TEXT,
        current_duration_seconds DOUBLE PRECISION,
        official_duration_seconds DOUBLE PRECISION,
        official_duration_source TEXT,
        reference_duration_seconds DOUBLE PRECISION,
        reference_duration_source TEXT,
        candidate_cache_json TEXT,
        local_candidates_json TEXT,
        selected_candidate_json TEXT,
        selected_local_filename TEXT,
        archive_filename TEXT,
        replacement_filename TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS upgrade_cases_status_idx
      ON upgrade_cases(status, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS download_attempts (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        want_list_id BIGINT,
        status TEXT NOT NULL DEFAULT 'queued',
        origin_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
        origin_artist TEXT NOT NULL,
        origin_title TEXT NOT NULL,
        origin_version TEXT,
        origin_year TEXT,
        origin_album TEXT,
        origin_label TEXT,
        origin_source_collection_filename TEXT,
        origin_discogs_release_id BIGINT,
        origin_discogs_track_position TEXT,
        search_query TEXT,
        slskd_search_id TEXT,
        username TEXT,
        remote_filename TEXT,
        remote_size BIGINT,
        bitrate INTEGER,
        duration_seconds DOUBLE PRECISION,
        extension TEXT,
        score INTEGER,
        queue_length INTEGER,
        has_free_upload_slot BOOLEAN,
        upload_speed BIGINT,
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        raw_candidate_json TEXT,
        expected_local_filename TEXT,
        local_filename TEXT,
        local_filesize BIGINT,
        error_message TEXT,
        requested_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS download_attempts_want_list_idx
      ON download_attempts(want_list_id, updated_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS download_attempts_status_idx
      ON download_attempts(status, updated_at, id);

      ALTER TABLE download_attempts ADD COLUMN IF NOT EXISTS expected_local_filename TEXT;

      CREATE INDEX IF NOT EXISTS download_attempts_expected_local_filename_idx
      ON download_attempts(expected_local_filename)
      WHERE expected_local_filename IS NOT NULL AND local_filename IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS download_attempts_remote_once_idx
      ON download_attempts(want_list_id, username, remote_filename, remote_size)
      WHERE want_list_id IS NOT NULL AND username IS NOT NULL AND remote_filename IS NOT NULL;

      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS want_kind TEXT NOT NULL DEFAULT 'missing';
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL;
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS source_collection_filename TEXT;
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS target_download_count INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS auto_download_enabled BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS last_search_at TIMESTAMPTZ;
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS next_search_at TIMESTAMPTZ;
      ALTER TABLE want_list ADD COLUMN IF NOT EXISTS selected_download_id BIGINT;
      ALTER TABLE download_attempts ADD COLUMN IF NOT EXISTS origin_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL;
      ALTER TABLE recordings ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION;
      ALTER TABLE file_identification_state ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

      UPDATE want_list wanted
      SET recording_id = file_identification_state.recording_id
      FROM file_identification_state
      WHERE wanted.recording_id IS NULL
        AND wanted.source_collection_filename = file_identification_state.filename
        AND file_identification_state.recording_id IS NOT NULL;

      UPDATE download_attempts attempts
      SET origin_recording_id = source.recording_id
      FROM (
        SELECT download_attempts.id, COALESCE(wanted.recording_id, file_identification_state.recording_id) AS recording_id
        FROM download_attempts
        LEFT JOIN want_list wanted ON wanted.id = download_attempts.want_list_id
        LEFT JOIN file_identification_state
          ON file_identification_state.filename = COALESCE(download_attempts.origin_source_collection_filename, wanted.source_collection_filename)
        WHERE download_attempts.origin_recording_id IS NULL
          AND COALESCE(wanted.recording_id, file_identification_state.recording_id) IS NOT NULL
      ) source
      WHERE attempts.id = source.id;

      UPDATE file_identification_state state
      SET recording_id = attempts.origin_recording_id,
          audio_hash = COALESCE(state.audio_hash, (
            SELECT file_audio_state.audio_hash
            FROM file_audio_state
            WHERE file_audio_state.filename = state.filename
              AND file_audio_state.status = 'ready'
              AND file_audio_state.audio_hash IS NOT NULL
            LIMIT 1
          )),
          status = 'ready',
          assignment_method = 'manual',
          confidence = 100,
          verified_at = COALESCE(state.verified_at, now()),
          error_message = NULL,
          processed_at = now()
      FROM download_attempts attempts
      WHERE attempts.local_filename = state.filename
        AND attempts.origin_recording_id IS NOT NULL
        AND state.recording_id IS DISTINCT FROM attempts.origin_recording_id;

      INSERT INTO audio_assets(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
      SELECT DISTINCT file_audio_state.audio_hash, attempts.origin_recording_id, NULLIF(NULLIF(audio_analysis_cache.analysis_json, '')::jsonb->>'durationSeconds', '')::double precision, 'manual', 100, now()
      FROM download_attempts attempts
      JOIN file_audio_state
        ON file_audio_state.filename = attempts.local_filename
       AND file_audio_state.status = 'ready'
       AND file_audio_state.audio_hash IS NOT NULL
      LEFT JOIN audio_analysis_cache
        ON audio_analysis_cache.audio_hash = file_audio_state.audio_hash
       AND audio_analysis_cache.analysis_version = ${AUDIO_ANALYSIS_VERSION}
      WHERE attempts.origin_recording_id IS NOT NULL
      ON CONFLICT(audio_hash) DO UPDATE SET
        recording_id = EXCLUDED.recording_id,
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_assets.duration_seconds),
        assigned_by = EXCLUDED.assigned_by,
        confidence = EXCLUDED.confidence,
        updated_at = now();

      INSERT INTO want_list (
        want_kind, recording_id, artist, title, version, year, album, label, added_at, pipeline_status,
        best_candidates_json, source_collection_filename, target_download_count, auto_download_enabled
      )
      SELECT
        'replacement',
        file_identification_state.recording_id,
        COALESCE(NULLIF(upgrade_cases_source.search_artist, ''), 'Unknown Artist'),
        COALESCE(NULLIF(upgrade_cases_source.search_title, ''), upgrade_cases_source.collection_filename),
        upgrade_cases_source.search_version,
        NULL,
        NULL,
        NULL,
        upgrade_cases_source.created_at,
        CASE WHEN upgrade_cases_source.status IN ('completed', 'pending_reanalyze') THEN 'downloaded' ELSE COALESCE(NULLIF(upgrade_cases_source.status, ''), 'idle') END,
        upgrade_cases_source.candidate_cache_json,
        upgrade_cases_source.collection_filename,
        3,
        TRUE
      FROM upgrade_cases upgrade_cases_source
      LEFT JOIN file_identification_state ON file_identification_state.filename = upgrade_cases_source.collection_filename
      WHERE NOT EXISTS (
        SELECT 1
        FROM want_list existing_want
        WHERE existing_want.want_kind = 'replacement'
          AND existing_want.source_collection_filename = upgrade_cases_source.collection_filename
      );

      INSERT INTO download_attempts (
        want_list_id, status, origin_recording_id, origin_artist, origin_title, origin_version, origin_year, origin_album, origin_label,
        origin_source_collection_filename, search_query, username, remote_filename, remote_size, duration_seconds,
        raw_candidate_json, expected_local_filename, local_filename, local_filesize, completed_at
      )
      SELECT
        wanted.id,
        'downloaded',
        wanted.recording_id,
        wanted.artist,
        wanted.title,
        wanted.version,
        wanted.year,
        wanted.album,
        wanted.label,
        wanted.source_collection_filename,
        concat_ws(' ', wanted.artist, wanted.title, wanted.version),
        candidate->>'sourceUsername',
        candidate->>'sourceFilename',
        NULLIF(candidate->>'filesize', '')::bigint,
        NULLIF(candidate->>'durationSeconds', '')::double precision,
        candidate::text,
        candidate->>'filename',
        candidate->>'filename',
        NULLIF(candidate->>'filesize', '')::bigint,
        now()
      FROM upgrade_cases upgrade_cases_source
      JOIN want_list wanted
        ON wanted.want_kind = 'replacement'
       AND wanted.source_collection_filename = upgrade_cases_source.collection_filename
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NULLIF(upgrade_cases_source.local_candidates_json, '')::jsonb, '[]'::jsonb)) candidate
      WHERE candidate ? 'filename'
        AND NOT EXISTS (
          SELECT 1
          FROM download_attempts existing_attempt
          WHERE existing_attempt.want_list_id = wanted.id
            AND existing_attempt.local_filename = candidate->>'filename'
        );
    `)
    await this.ensureSchemaVersion()
    await this.materializeRecordingDurations()
  }

  private async materializeRecordingDurations(recordingIds?: number[], client?: Pool | PoolClient): Promise<void> {
    const db = client ?? this.pool
    const values = recordingIds?.length ? [recordingIds] : []
    const whereSql = recordingIds?.length ? 'WHERE recordings.id = ANY($1::bigint[])' : ''
    await db.query(
      `
        UPDATE recordings
        SET duration_seconds = candidate.duration_seconds, updated_at = now()
        FROM (
          SELECT recordings.id,
            COALESCE(
              (
                SELECT duration_seconds
                FROM recording_source_claims
                WHERE recording_id = recordings.id AND duration_seconds IS NOT NULL
                ORDER BY confidence DESC, updated_at DESC, id DESC
                LIMIT 1
              ),
              (
                SELECT duration_seconds
                FROM audio_assets
                WHERE recording_id = recordings.id AND duration_seconds IS NOT NULL
                ORDER BY confidence DESC, updated_at DESC, audio_hash
                LIMIT 1
              )
            ) AS duration_seconds
          FROM recordings
          ${whereSql}
        ) candidate
        WHERE recordings.id = candidate.id
          AND recordings.duration_seconds IS DISTINCT FROM candidate.duration_seconds
      `,
      values
    )
  }

  private async archiveIdentificationStateWithClient(client: PoolClient, filenames: string[]): Promise<void> {
    const unique = [...new Set(filenames.filter(Boolean))]
    if (unique.length === 0) return
    await client.query(
      `
        WITH candidates AS (
          SELECT filename, jsonb_agg(jsonb_build_object(
            'provider', provider,
            'entityType', entity_type,
            'externalKey', external_key,
            'proposedRecordingId', proposed_recording_id,
            'score', score,
            'disposition', disposition,
            'payloadJson', payload_json
          ) ORDER BY score DESC, id) AS candidates_json
          FROM file_identification_candidates
          WHERE filename = ANY($1::text[])
          GROUP BY filename
        )
        INSERT INTO file_identification_archive(
          filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
          parsed_artist, parsed_title, parsed_version, parsed_year, tag_artist, tag_title, tag_version,
          chosen_claim_id, identify_version, explanation_json, verified_at, error_message, processed_at,
          candidates_json, archived_at
        )
        SELECT
          state.filename, state.filesize, state.mtime_ms, state.recording_id, state.audio_hash, state.status,
          state.assignment_method, state.confidence, state.parsed_artist, state.parsed_title, state.parsed_version,
          state.parsed_year, state.tag_artist, state.tag_title, state.tag_version, state.chosen_claim_id,
          state.identify_version, state.explanation_json, state.verified_at, state.error_message, state.processed_at,
          COALESCE(candidates.candidates_json, '[]'::jsonb), now()
        FROM file_identification_state state
        LEFT JOIN candidates ON candidates.filename = state.filename
        WHERE state.filename = ANY($1::text[])
        ON CONFLICT(filename) DO UPDATE SET
          filesize = EXCLUDED.filesize,
          mtime_ms = EXCLUDED.mtime_ms,
          recording_id = EXCLUDED.recording_id,
          audio_hash = EXCLUDED.audio_hash,
          status = EXCLUDED.status,
          assignment_method = EXCLUDED.assignment_method,
          confidence = EXCLUDED.confidence,
          parsed_artist = EXCLUDED.parsed_artist,
          parsed_title = EXCLUDED.parsed_title,
          parsed_version = EXCLUDED.parsed_version,
          parsed_year = EXCLUDED.parsed_year,
          tag_artist = EXCLUDED.tag_artist,
          tag_title = EXCLUDED.tag_title,
          tag_version = EXCLUDED.tag_version,
          chosen_claim_id = EXCLUDED.chosen_claim_id,
          identify_version = EXCLUDED.identify_version,
          explanation_json = EXCLUDED.explanation_json,
          verified_at = EXCLUDED.verified_at,
          error_message = EXCLUDED.error_message,
          processed_at = EXCLUDED.processed_at,
          candidates_json = EXCLUDED.candidates_json,
          archived_at = now()
      `,
      [unique]
    )
  }

  private async restoreArchivedIdentificationWithClient(
    client: PoolClient,
    filename: string,
    change: Pick<SyncChange, 'filesize' | 'mtimeMs'>
  ): Promise<boolean> {
    const restored = await client.query<{ recordingid: number | bigint | null }>(
      `
        INSERT INTO file_identification_state(
          filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
          parsed_artist, parsed_title, parsed_version, parsed_year, tag_artist, tag_title, tag_version,
          chosen_claim_id, identify_version, explanation_json, verified_at, error_message, processed_at
        )
        SELECT
          $1, $2, $3,
          CASE WHEN archive.recording_id IS NOT NULL AND EXISTS (SELECT 1 FROM recordings WHERE id = archive.recording_id) THEN archive.recording_id ELSE NULL END,
          archive.audio_hash, archive.status, archive.assignment_method, archive.confidence,
          archive.parsed_artist, archive.parsed_title, archive.parsed_version, archive.parsed_year,
          archive.tag_artist, archive.tag_title, archive.tag_version,
          CASE WHEN archive.chosen_claim_id IS NOT NULL AND EXISTS (SELECT 1 FROM recording_source_claims WHERE id = archive.chosen_claim_id) THEN archive.chosen_claim_id ELSE NULL END,
          archive.identify_version, archive.explanation_json, archive.verified_at, archive.error_message, archive.processed_at
        FROM file_identification_archive archive
        WHERE archive.filename = $1
          AND archive.filesize = $2
          AND (archive.recording_id IS NOT NULL OR archive.assignment_method IS NOT NULL OR archive.verified_at IS NOT NULL OR archive.status IN ('ready', 'needs_review'))
        ON CONFLICT(filename) DO UPDATE SET
          filesize = EXCLUDED.filesize,
          mtime_ms = EXCLUDED.mtime_ms,
          recording_id = EXCLUDED.recording_id,
          audio_hash = EXCLUDED.audio_hash,
          status = EXCLUDED.status,
          assignment_method = EXCLUDED.assignment_method,
          confidence = EXCLUDED.confidence,
          parsed_artist = EXCLUDED.parsed_artist,
          parsed_title = EXCLUDED.parsed_title,
          parsed_version = EXCLUDED.parsed_version,
          parsed_year = EXCLUDED.parsed_year,
          tag_artist = EXCLUDED.tag_artist,
          tag_title = EXCLUDED.tag_title,
          tag_version = EXCLUDED.tag_version,
          chosen_claim_id = EXCLUDED.chosen_claim_id,
          identify_version = EXCLUDED.identify_version,
          explanation_json = EXCLUDED.explanation_json,
          verified_at = EXCLUDED.verified_at,
          error_message = EXCLUDED.error_message,
          processed_at = EXCLUDED.processed_at
        RETURNING recording_id AS recordingId
      `,
      [filename, change.filesize, change.mtimeMs]
    )
    if (!restored.rowCount) return false
    await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [filename])
    await client.query(
      `
        INSERT INTO file_identification_candidates(
          filename, provider, entity_type, external_key, proposed_recording_id, score, disposition, payload_json, processed_at
        )
        SELECT
          $1, candidate.provider, candidate."entityType", candidate."externalKey",
          CASE WHEN candidate."proposedRecordingId" IS NOT NULL AND EXISTS (SELECT 1 FROM recordings WHERE id = candidate."proposedRecordingId") THEN candidate."proposedRecordingId" ELSE NULL END,
          candidate.score, candidate.disposition, candidate."payloadJson", now()
        FROM file_identification_archive archive
        CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(archive.candidates_json, '[]'::jsonb)) AS candidate(
          provider text, "entityType" text, "externalKey" text, "proposedRecordingId" bigint, score int, disposition text, "payloadJson" jsonb
        )
        WHERE archive.filename = $1 AND archive.filesize = $2
      `,
      [filename, change.filesize]
    )
    const recordingId = restored.rows[0]?.recordingid
    if (recordingId != null) await this.materializeRecordingDurations([toNumber(recordingId)], client)
    return true
  }

  private async runSyncPass(): Promise<string | null> {
    const dropboxConfig = readDropboxFileSourceConfig(this.settings)
    if (dropboxConfig) return this.runDropboxSyncPass(dropboxConfig)

    const context = await resolveScanContext(this.settings)
    if (!context.musicRootPath || context.scanRoots.length === 0) {
      return context.warning
    }

    const knownState = await this.readKnownState()
    const seen = new Set<string>()
    const changed = new Map<string, SyncChange>()
    let hadReadError = false

    if (context.musicRootPath && context.scanRoots.length > 0) {
      for (const rootPath of context.scanRoots) {
        hadReadError =
          (await scanDirectory(
            rootPath,
            context.musicRootPath,
            knownState,
            seen,
            changed,
            context.downloadRootPaths
          )) ||
          hadReadError
      }
    }

    const removed: string[] = []
    if (!hadReadError) {
      for (const filename of knownState.keys()) {
        if (!seen.has(filename)) {
          removed.push(filename)
        }
      }
    }

    await this.applyChanges(changed, removed)
    this.status.itemCount = await this.readItemCount()
    if (hadReadError) {
      return 'One or more scan folders could not be read. Existing collection entries were preserved.'
    }
    return context.warning
  }

  private async runDropboxSyncPass(dropboxConfig: DropboxFileSourceConfig): Promise<string | null> {
    const knownState = await this.readKnownState()
    const scanned = await listDropboxAudioFiles(dropboxConfig)
    const seen = new Set(scanned.map((file) => file.filename))
    const changed = new Map<string, SyncChange>()
    for (const file of scanned) {
      if (knownState.get(file.filename) !== file.mtimeMs) {
        changed.set(file.filename, { filesize: file.filesize, mtimeMs: file.mtimeMs })
      }
    }
    const removed = [...knownState.keys()].filter((filename) => !seen.has(filename))
    await this.applyChanges(changed, removed)
    this.status.itemCount = await this.readItemCount()
    return null
  }

  private async readKnownState(): Promise<Map<string, number>> {
    const rows = (
      await this.pool.query<{ filename: string; mtimems: number | bigint }>(
        `
          SELECT filename, mtime_ms AS mtimeMs
          FROM collection_file_state
        `
      )
    ).rows

    const stateByFilename = new Map<string, number>()
    for (const row of rows) {
      stateByFilename.set(row.filename, toNumber(row.mtimems))
    }
    return stateByFilename
  }

  private async applyChanges(changed: Map<string, SyncChange>, removed: string[]): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.archiveIdentificationStateWithClient(client, [...changed.keys(), ...removed])

      for (const [filename, change] of changed.entries()) {
        await client.query(
          `
            INSERT INTO collection_files(filename, filesize)
            VALUES ($1, $2)
            ON CONFLICT(filename) DO UPDATE SET filesize = excluded.filesize
          `,
          [filename, change.filesize]
        )
        await client.query(
          `
            INSERT INTO collection_file_state(filename, mtime_ms)
            VALUES ($1, $2)
            ON CONFLICT(filename) DO UPDATE SET mtime_ms = excluded.mtime_ms
          `,
          [filename, change.mtimeMs]
        )
      }

      for (const filename of removed) {
        await client.query('DELETE FROM collection_files WHERE filename = $1', [filename])
      }

      const linked = await this.syncDownloadAttemptFileLinksWithClient(client, removed)
      const reviewChanges = new Map([...changed, ...linked])
      const touchedImportQueue = await this.syncImportReviewCacheWithClient(client, reviewChanges, removed)
      const touchedIdentificationQueue = await this.syncIdentificationStateWithClient(client, reviewChanges, removed)
      await this.syncFileAnalysisStateWithClient(client, changed, removed)

      await client.query('COMMIT')

      if (touchedImportQueue) {
        await this.refreshImportQueueCounts()
        this.emitStatus()
        this.onImportQueueChanged?.()
      }
      if (touchedIdentificationQueue) {
        await this.refreshIdentificationQueueCounts()
        this.emitStatus()
        this.onIdentificationQueueChanged?.()
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  public async queueImportReviewFiles(filenames: string[] = [], force: boolean = false): Promise<number> {
    await this.ensureReady()
    const uniqueFilenames = [...new Set(filenames.map(normalizeFilename).filter(Boolean))]
    const targetFilenames =
      uniqueFilenames.length > 0
        ? uniqueFilenames
        : (await this.listDownloads()).items.map((item) => item.filename)
    if (targetFilenames.length === 0) return 0

    const client = await this.pool.connect()
    let queued = 0
    try {
      await client.query('BEGIN')

      for (const filename of targetFilenames) {
        if (!isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)) continue

        const stateRow = (
          await client.query<{
            filename: string
            filesize: number | bigint
            mtimems: number | bigint
            cachestatus: string | null
            cachereviewversion: number | bigint | null
            cachefilesize: number | bigint | null
            cachemtimems: number | bigint | null
          }>(
            `
              SELECT
                collection_files.filename,
                collection_files.filesize,
                collection_file_state.mtime_ms AS mtimeMs,
                import_review_cache.status AS cacheStatus,
                import_review_cache.review_version AS cacheReviewVersion,
                import_review_cache.filesize AS cacheFilesize,
                import_review_cache.mtime_ms AS cacheMtimeMs
              FROM collection_files
              JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
              LEFT JOIN import_review_cache ON import_review_cache.filename = collection_files.filename
              WHERE collection_files.filename = $1
            `,
            [filename]
          )
        ).rows[0]
        if (!stateRow) continue

        const needsQueue =
          force ||
          stateRow.cachestatus !== 'ready' ||
          toNumber(stateRow.cachereviewversion ?? 0) !== IMPORT_REVIEW_VERSION ||
          toNumber(stateRow.cachefilesize ?? 0) !== toNumber(stateRow.filesize) ||
          toNumber(stateRow.cachemtimems ?? 0) !== toNumber(stateRow.mtimems)
        if (!needsQueue) continue

        const parsed = parseImportFilename(filename)
        await client.query(
          `
            INSERT INTO import_review_cache(
              filename, filesize, mtime_ms, review_version, status,
              parsed_artist, parsed_title, parsed_version, parsed_year,
              review_json, error_message, processed_at
            ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, NULL, NULL, NULL)
            ON CONFLICT(filename) DO UPDATE SET
              filesize = excluded.filesize,
              mtime_ms = excluded.mtime_ms,
              review_version = excluded.review_version,
              status = 'pending',
              parsed_artist = excluded.parsed_artist,
              parsed_title = excluded.parsed_title,
              parsed_version = excluded.parsed_version,
              parsed_year = excluded.parsed_year,
              review_json = NULL,
              error_message = NULL,
              processed_at = NULL
          `,
          [
            filename,
            toNumber(stateRow.filesize),
            toNumber(stateRow.mtimems),
            IMPORT_REVIEW_VERSION,
            parsed?.artist ?? null,
            parsed?.title ?? null,
            parsed?.version ?? null,
            parsed?.year ?? null
          ]
        )
        queued += 1
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    await this.refreshImportQueueCounts()
    if (queued > 0) {
      this.emitStatus()
      this.onImportQueueChanged?.()
    }
    return queued
  }

  public async resetImportReviewProcessing(): Promise<void> {
    await this.ensureReady()
    await this.pool.query(`UPDATE import_review_cache SET status = 'pending' WHERE status = 'processing'`)
    await this.refreshImportQueueCounts()
    this.emitStatus()
  }

  public async claimNextPendingImportReview(): Promise<
    | {
        filename: string
        filesize: number
        mtimeMs: number
        parsedArtist: string | null
        parsedTitle: string | null
        parsedVersion: string | null
      }
    | null
  > {
    await this.ensureReady()
    const row = (
      await this.pool.query<{
        filename: string
        filesize: number | bigint
        mtimems: number | bigint
        parsedartist: string | null
        parsedtitle: string | null
        parsedversion: string | null
      }>(
        `
          UPDATE import_review_cache
          SET status = 'processing'
          WHERE filename = (
            SELECT filename
            FROM import_review_cache
            WHERE status = 'pending'
            ORDER BY (processed_at IS NOT NULL), processed_at, filename
            LIMIT 1
          )
          RETURNING
            filename,
            filesize,
            mtime_ms AS mtimeMs,
            parsed_artist AS parsedArtist,
            parsed_title AS parsedTitle,
            parsed_version AS parsedVersion
        `
      )
    ).rows[0]

    if (!row) return null

    await this.refreshImportQueueCounts()
    this.emitStatus()
    return {
      filename: row.filename,
      filesize: toNumber(row.filesize),
      mtimeMs: toNumber(row.mtimems),
      parsedArtist: row.parsedartist ?? null,
      parsedTitle: row.parsedtitle ?? null,
      parsedVersion: row.parsedversion ?? null
    }
  }

  public async readImportReviewCache(filename: string): Promise<string | null> {
    await this.ensureReady()
    const row = (
      await this.pool.query<{ reviewjson: string | null }>(
        `
          SELECT import_review_cache.review_json AS reviewJson
          FROM import_review_cache
          JOIN collection_files ON collection_files.filename = import_review_cache.filename
          JOIN collection_file_state ON collection_file_state.filename = import_review_cache.filename
          WHERE import_review_cache.filename = $1
            AND import_review_cache.status = 'ready'
            AND import_review_cache.review_version = $2
            AND import_review_cache.mtime_ms = collection_file_state.mtime_ms
            AND import_review_cache.filesize = collection_files.filesize
        `,
        [filename, IMPORT_REVIEW_VERSION]
      )
    ).rows[0]
    return row?.reviewjson ?? null
  }

  public async saveImportReviewCache(
    filename: string,
    data: {
      filesize: number
      mtimeMs: number
      parsedArtist: string | null
      parsedTitle: string | null
      parsedVersion: string | null
      parsedYear: string | null
      reviewJson: string
    }
  ): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO import_review_cache(
          filename, filesize, mtime_ms, review_version, status,
          parsed_artist, parsed_title, parsed_version, parsed_year,
          review_json, error_message, processed_at
        ) VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7, $8, $9, NULL, now())
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          review_version = excluded.review_version,
          status = 'ready',
          parsed_artist = excluded.parsed_artist,
          parsed_title = excluded.parsed_title,
          parsed_version = excluded.parsed_version,
          parsed_year = excluded.parsed_year,
          review_json = excluded.review_json,
          error_message = NULL,
          processed_at = now()
      `,
      [
        filename,
        data.filesize,
        data.mtimeMs,
        IMPORT_REVIEW_VERSION,
        data.parsedArtist,
        data.parsedTitle,
        data.parsedVersion,
        data.parsedYear,
        data.reviewJson
      ]
    )
    await this.refreshImportQueueCounts()
    this.emitStatus()
  }

  public async promoteImportReviewIdentification(filename: string): Promise<boolean> {
    await this.ensureReady()
    const item = await this.getItem(filename)
    const reviewJson = (
      await this.pool.query<{ reviewjson: string | null }>(
        `SELECT review_json AS reviewJson FROM import_review_cache WHERE filename = $1 AND status = 'ready'`,
        [filename]
      )
    ).rows[0]?.reviewjson
    const review = parseImportReview(reviewJson)
    const claim = parseImportReviewClaim(reviewJson)
    const candidate = review?.candidates[review.selectedCandidateIndex ?? 0] ?? review?.candidates[0] ?? null
    if (!item?.isDownload || item.recordingId != null || !claim || !candidate) return false
    const matchedSource = (await this.findSourceClaimMatches([claim.externalKey]))[0] ?? null
    const canonical = { artist: claim.artist, title: claim.title, version: claim.version, year: claim.year }
    await this.saveIdentificationDecision(filename, {
      filesize: item.filesize,
      mtimeMs: item.mtimeMs ?? item.importReview?.mtimeMs ?? item.fileAudioState?.mtimeMs ?? Date.now(),
      status: 'ready',
      assignmentMethod: 'source_claim',
      confidence: claim.confidence,
      recordingId: matchedSource?.recordingId ?? null,
      createRecording: matchedSource ? null : { canonical, confidence: claim.confidence, reviewState: 'auto' },
      audioHash: item.fileAudioState?.audioHash ?? item.identification?.audioHash ?? null,
      parsedArtist: review?.parsed?.artist ?? null,
      parsedTitle: review?.parsed?.title ?? null,
      parsedVersion: review?.parsed?.version ?? null,
      parsedYear: item.importReview?.parsedYear ?? null,
      tagArtist: item.tags?.artist ?? null,
      tagTitle: item.tags?.title ?? null,
      tagVersion: item.tags?.version ?? null,
      chosenClaimId: matchedSource?.claimId ?? null,
      chosenExternalKey: claim.externalKey,
      acceptedClaims: [claim],
      candidates: [{
        provider: claim.provider,
        entityType: claim.entityType,
        externalKey: claim.externalKey,
        proposedRecordingId: matchedSource?.recordingId ?? null,
        score: claim.confidence,
        disposition: 'candidate',
        payloadJson: claim.rawJson,
        recordingCanonical: matchedSource?.canonical ?? canonical
      }],
      explanationJson: JSON.stringify({
        reason: 'import_review_ready',
        importTrackKey: review ? buildImportTrackKey(review) : null,
        releaseId: candidate.match.releaseId,
        trackPosition: candidate.match.trackPosition ?? null
      }),
      recordingCanonical: matchedSource?.canonical ?? canonical
    })
    return true
  }

  public async saveImportReviewError(
    filename: string,
    data: {
      filesize: number
      mtimeMs: number
      parsedArtist: string | null
      parsedTitle: string | null
      parsedVersion: string | null
      parsedYear: string | null
      errorMessage: string
    }
  ): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO import_review_cache(
          filename, filesize, mtime_ms, review_version, status,
          parsed_artist, parsed_title, parsed_version, parsed_year,
          review_json, error_message, processed_at
        ) VALUES ($1, $2, $3, $4, 'error', $5, $6, $7, $8, NULL, $9, now())
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          review_version = excluded.review_version,
          status = 'error',
          parsed_artist = excluded.parsed_artist,
          parsed_title = excluded.parsed_title,
          parsed_version = excluded.parsed_version,
          parsed_year = excluded.parsed_year,
          review_json = NULL,
          error_message = excluded.error_message,
          processed_at = now()
      `,
      [
        filename,
        data.filesize,
        data.mtimeMs,
        IMPORT_REVIEW_VERSION,
        data.parsedArtist,
        data.parsedTitle,
        data.parsedVersion,
        data.parsedYear,
        data.errorMessage
      ]
    )
    await this.refreshImportQueueCounts()
    this.emitStatus()
  }

  public async readAssignedDiscogsTrackMatch(filenameInput: string): Promise<DiscogsTrackMatch | null> {
    await this.ensureReady()
    const filename = normalizeFilename(filenameInput)
    const row = (await this.pool.query<{ rawjson: unknown }>(
      `
        SELECT claims.raw_json AS rawJson
        FROM collection_files
        LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
        LEFT JOIN LATERAL (
          SELECT COALESCE(download_attempts.origin_recording_id, want_list.recording_id) AS recordingId
          FROM download_attempts
          LEFT JOIN want_list ON want_list.id = download_attempts.want_list_id
          WHERE download_attempts.local_filename = collection_files.filename
          ORDER BY download_attempts.completed_at DESC NULLS LAST, download_attempts.updated_at DESC, download_attempts.id DESC
          LIMIT 1
        ) download_origin ON TRUE
        JOIN recording_source_claims claims
          ON claims.recording_id = COALESCE(file_identification_state.recording_id, download_origin.recordingId)
         AND claims.provider = 'discogs'
         AND claims.entity_type = 'release_track'
        WHERE collection_files.filename = $1
        ORDER BY claims.confidence DESC, claims.id
        LIMIT 1
      `,
      [filename]
    )).rows[0]
    return parseDiscogsTrackMatch(row?.rawjson)
  }

  public async listPendingImportReviewFilenames(): Promise<string[]> {
    await this.ensureReady()
    return (
      await this.pool.query<{ filename: string }>(
        `
          SELECT filename
          FROM import_review_cache
          WHERE status = 'pending'
          ORDER BY (processed_at IS NOT NULL), processed_at, filename
        `
      )
    ).rows.map((row) => row.filename)
  }

  public async claimImportReviewFile(filename: string): Promise<
    | {
        filename: string
        filesize: number
        mtimeMs: number
        parsedArtist: string | null
        parsedTitle: string | null
        parsedVersion: string | null
      }
    | null
  > {
    await this.ensureReady()
    const row = (
      await this.pool.query<{
        filename: string
        filesize: number | bigint
        mtimems: number | bigint
        parsedartist: string | null
        parsedtitle: string | null
        parsedversion: string | null
      }>(
        `
          UPDATE import_review_cache
          SET status = 'processing'
          WHERE filename = $1 AND status = 'pending'
          RETURNING
            filename,
            filesize,
            mtime_ms AS mtimeMs,
            parsed_artist AS parsedArtist,
            parsed_title AS parsedTitle,
            parsed_version AS parsedVersion
        `,
        [filename]
      )
    ).rows[0]

    if (!row) return null

    await this.refreshImportQueueCounts()
    this.emitStatus()
    return {
      filename: row.filename,
      filesize: toNumber(row.filesize),
      mtimeMs: toNumber(row.mtimems),
      parsedArtist: row.parsedartist ?? null,
      parsedTitle: row.parsedtitle ?? null,
      parsedVersion: row.parsedversion ?? null
    }
  }

  public async queueIdentificationFiles(filenames: string[] = [], force: boolean = false): Promise<number> {
    await this.ensureReady()
    const uniqueFilenames = [...new Set(filenames.map(normalizeFilename).filter(Boolean))]
    const targetFilenames =
      uniqueFilenames.length > 0
        ? uniqueFilenames
        : (
            await this.pool.query<{ filename: string }>(
              `
                SELECT filename
                FROM collection_files
                ORDER BY lower(filename)
              `
            )
          ).rows.map((row) => row.filename)
    if (targetFilenames.length === 0) return 0

    const client = await this.pool.connect()
    let queued = 0
    try {
      await client.query('BEGIN')
      for (const filename of targetFilenames) {
        const stateRow = (
          await client.query<{
            filename: string
            filesize: number | bigint
            mtimems: number | bigint
            cachestatus: IdentificationStatus | null
            cacheidentifyversion: number | bigint | null
            cachefilesize: number | bigint | null
            cachemtimems: number | bigint | null
            cacheaudiohash: string | null
            currentaudiohash: string | null
          }>(
            `
              SELECT
                collection_files.filename,
                collection_files.filesize,
                collection_file_state.mtime_ms AS mtimeMs,
                file_identification_state.status AS cacheStatus,
                file_identification_state.identify_version AS cacheIdentifyVersion,
                file_identification_state.filesize AS cacheFilesize,
                file_identification_state.mtime_ms AS cacheMtimeMs,
                file_identification_state.audio_hash AS cacheAudioHash,
                file_audio_state.audio_hash AS currentAudioHash
              FROM collection_files
              JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
              LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
              LEFT JOIN file_audio_state
                ON file_audio_state.filename = collection_files.filename
               AND file_audio_state.status = 'ready'
               AND file_audio_state.hash_version = $2
               AND file_audio_state.filesize = collection_files.filesize
               AND file_audio_state.mtime_ms = collection_file_state.mtime_ms
              WHERE collection_files.filename = $1
            `,
            [filename, AUDIO_HASH_VERSION]
          )
        ).rows[0]
        if (!stateRow) continue

        const currentAudioHash = stateRow.currentaudiohash ?? null
        const needsQueue =
          force ||
          !stateRow.cachestatus ||
          stateRow.cachestatus === 'pending' ||
          stateRow.cachestatus === 'processing' ||
          stateRow.cachestatus === 'error' ||
          toNumber(stateRow.cacheidentifyversion ?? 0) !== IDENTIFY_VERSION ||
          toNumber(stateRow.cachefilesize ?? 0) !== toNumber(stateRow.filesize) ||
          toNumber(stateRow.cachemtimems ?? 0) !== toNumber(stateRow.mtimems) ||
          (stateRow.cacheaudiohash ?? null) !== currentAudioHash
        if (!needsQueue) continue

        const parsed = parseImportFilename(filename)
        const origin = isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)
          ? await this.readDownloadAttemptOriginWithClient(client, filename)
          : null
        const seed = buildDownloadOriginIdentificationSeed(origin, parsed)
        if (seed.recordingId != null) {
          await client.query(
            `
              INSERT INTO file_identification_state(
                filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
                parsed_artist, parsed_title, parsed_version, parsed_year,
                tag_artist, tag_title, tag_version, chosen_claim_id,
                identify_version, explanation_json, verified_at, error_message, processed_at
              ) VALUES ($1, $2, $3, $4, $5, 'ready', 'manual', 100, $6, $7, $8, $9, NULL, NULL, NULL, NULL, $10, NULL, now(), NULL, now())
              ON CONFLICT(filename) DO UPDATE SET
                filesize = excluded.filesize,
                mtime_ms = excluded.mtime_ms,
                recording_id = excluded.recording_id,
                audio_hash = excluded.audio_hash,
                status = 'ready',
                assignment_method = 'manual',
                confidence = 100,
                parsed_artist = excluded.parsed_artist,
                parsed_title = excluded.parsed_title,
                parsed_version = excluded.parsed_version,
                parsed_year = excluded.parsed_year,
                identify_version = excluded.identify_version,
                verified_at = COALESCE(file_identification_state.verified_at, now()),
                error_message = NULL,
                processed_at = now()
            `,
            [
              filename,
              toNumber(stateRow.filesize),
              toNumber(stateRow.mtimems),
              seed.recordingId,
              currentAudioHash,
              seed.parsedArtist,
              seed.parsedTitle,
              seed.parsedVersion,
              seed.parsedYear,
              IDENTIFY_VERSION
            ]
          )
          if (currentAudioHash) {
            await client.query(
              `
                INSERT INTO audio_assets(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
                SELECT $1, $2, NULLIF(NULLIF(audio_analysis_cache.analysis_json, '')::jsonb->>'durationSeconds', '')::double precision, 'manual', 100, now()
                FROM (SELECT 1) seed
                LEFT JOIN audio_analysis_cache
                  ON audio_analysis_cache.audio_hash = $1
                 AND audio_analysis_cache.analysis_version = $3
                ON CONFLICT(audio_hash) DO UPDATE SET
                  recording_id = EXCLUDED.recording_id,
                  duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_assets.duration_seconds),
                  assigned_by = EXCLUDED.assigned_by,
                  confidence = EXCLUDED.confidence,
                  updated_at = now()
              `,
              [currentAudioHash, seed.recordingId, AUDIO_ANALYSIS_VERSION]
            )
          }
          await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [filename])
          continue
        }
        await client.query(
          `
            INSERT INTO file_identification_state(
              filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
              parsed_artist, parsed_title, parsed_version, parsed_year,
              tag_artist, tag_title, tag_version, chosen_claim_id,
              identify_version, explanation_json, verified_at, error_message, processed_at
            ) VALUES ($1, $2, $3, NULL, $4, 'pending', NULL, NULL, $5, $6, $7, $8, NULL, NULL, NULL, NULL, $9, NULL, NULL, NULL, NULL)
            ON CONFLICT(filename) DO UPDATE SET
              filesize = excluded.filesize,
              mtime_ms = excluded.mtime_ms,
              audio_hash = excluded.audio_hash,
              status = 'pending',
              assignment_method = NULL,
              confidence = NULL,
              parsed_artist = excluded.parsed_artist,
              parsed_title = excluded.parsed_title,
              parsed_version = excluded.parsed_version,
              parsed_year = excluded.parsed_year,
              tag_artist = NULL,
              tag_title = NULL,
              tag_version = NULL,
              chosen_claim_id = NULL,
              identify_version = excluded.identify_version,
              explanation_json = NULL,
              verified_at = NULL,
              error_message = NULL,
              processed_at = NULL
          `,
          [
            filename,
            toNumber(stateRow.filesize),
            toNumber(stateRow.mtimems),
            currentAudioHash,
            seed.parsedArtist,
            seed.parsedTitle,
            seed.parsedVersion,
            seed.parsedYear,
            IDENTIFY_VERSION
          ]
        )
        queued += 1
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    await this.refreshIdentificationQueueCounts()
    if (queued > 0) this.emitStatus()
    return queued
  }

  public async resetIdentificationProcessing(): Promise<void> {
    await this.ensureReady()
    await this.pool.query(`UPDATE file_identification_state SET status = 'pending' WHERE status = 'processing'`)
    await this.refreshIdentificationQueueCounts()
    this.emitStatus()
  }

  public async listPendingIdentificationFilenames(): Promise<string[]> {
    await this.ensureReady()
    return (
      await this.pool.query<{ filename: string }>(
        `
          SELECT filename
          FROM file_identification_state
          WHERE status = 'pending'
          ORDER BY (processed_at IS NOT NULL), processed_at, filename
        `
      )
    ).rows.map((row) => row.filename)
  }

  public async claimIdentificationFile(filename: string): Promise<{ filename: string; filesize: number; mtimeMs: number } | null> {
    await this.ensureReady()
    const row = (
      await this.pool.query<{ filename: string; filesize: number | bigint; mtimems: number | bigint }>(
        `
          UPDATE file_identification_state
          SET status = 'processing'
          WHERE filename = $1 AND status = 'pending'
          RETURNING filename, filesize, mtime_ms AS mtimeMs
        `,
        [filename]
      )
    ).rows[0]
    if (!row) return null
    await this.refreshIdentificationQueueCounts()
    this.emitStatus()
    return {
      filename: row.filename,
      filesize: toNumber(row.filesize),
      mtimeMs: toNumber(row.mtimems)
    }
  }

  public async readRejectedIdentificationExternalKeys(filename: string): Promise<Set<string>> {
    await this.ensureReady()
    return new Set(
      (
        await this.pool.query<{ externalkey: string }>(
          `
            SELECT external_key AS externalKey
            FROM file_identification_candidates
            WHERE filename = $1 AND disposition = 'rejected'
          `,
          [filename]
        )
      ).rows.map((row) => row.externalkey)
    )
  }

  public async saveIdentificationDecision(
    filename: string,
    data: { filesize: number; mtimeMs: number } & IdentificationDecision
  ): Promise<void> {
    await this.ensureReady()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      let recordingId = data.recordingId
      if (!recordingId && data.createRecording) {
        const created = (
          await client.query<{ id: number | bigint }>(
            `
              INSERT INTO recordings(
                canonical_artist, canonical_title, canonical_version, canonical_year, canonical_norm_key,
                confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NULL, now())
              RETURNING id
            `,
            [
              data.createRecording.canonical.artist,
              data.createRecording.canonical.title,
              data.createRecording.canonical.version,
              data.createRecording.canonical.year,
              buildCanonicalNormKey(data.createRecording.canonical),
              data.createRecording.confidence,
              data.createRecording.reviewState
            ]
          )
        ).rows[0]
        recordingId = created ? toNumber(created.id) : null
      }

      const claimIds = new Map<string, number>()
      for (const claim of data.acceptedClaims) {
        if (!recordingId) continue
        const claimRow = (
          await client.query<{ id: number | bigint }>(
            `
              INSERT INTO recording_source_claims(
                recording_id, provider, entity_type, external_key,
                artist, title, version, release_title, track_position, year, duration_seconds,
                confidence, raw_json, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now())
              ON CONFLICT(provider, entity_type, external_key) DO UPDATE SET
                recording_id = EXCLUDED.recording_id,
                artist = COALESCE(EXCLUDED.artist, recording_source_claims.artist),
                title = COALESCE(EXCLUDED.title, recording_source_claims.title),
                version = COALESCE(EXCLUDED.version, recording_source_claims.version),
                release_title = COALESCE(EXCLUDED.release_title, recording_source_claims.release_title),
                track_position = COALESCE(EXCLUDED.track_position, recording_source_claims.track_position),
                year = COALESCE(EXCLUDED.year, recording_source_claims.year),
                duration_seconds = COALESCE(EXCLUDED.duration_seconds, recording_source_claims.duration_seconds),
                confidence = GREATEST(recording_source_claims.confidence, EXCLUDED.confidence),
                raw_json = COALESCE(EXCLUDED.raw_json, recording_source_claims.raw_json),
                updated_at = now()
              RETURNING id
            `,
            [
              recordingId,
              claim.provider,
              claim.entityType,
              claim.externalKey,
              claim.artist,
              claim.title,
              claim.version,
              claim.releaseTitle,
              claim.trackPosition,
              claim.year,
              claim.durationSeconds,
              claim.confidence,
              normalizeJsonText(claim.rawJson)
            ]
          )
        ).rows[0]
        if (claimRow) claimIds.set(claim.externalKey, toNumber(claimRow.id))
      }

      if (recordingId && data.recordingCanonical) {
        await client.query(
          `
            UPDATE recordings
            SET
              canonical_artist = CASE WHEN metadata_locked THEN canonical_artist ELSE COALESCE($2, canonical_artist) END,
              canonical_title = CASE WHEN metadata_locked THEN canonical_title ELSE COALESCE($3, canonical_title) END,
              canonical_version = CASE WHEN metadata_locked THEN canonical_version ELSE $4 END,
              canonical_year = CASE WHEN metadata_locked THEN canonical_year ELSE COALESCE($5, canonical_year) END,
              canonical_norm_key = CASE
                WHEN metadata_locked THEN canonical_norm_key
                ELSE COALESCE(NULLIF($6, ''), canonical_norm_key)
              END,
              confidence = GREATEST(confidence, $7),
              updated_at = now()
            WHERE id = $1
          `,
          [
            recordingId,
            data.recordingCanonical.artist,
            data.recordingCanonical.title,
            data.recordingCanonical.version,
            data.recordingCanonical.year,
            buildCanonicalNormKey(data.recordingCanonical),
            data.confidence ?? 0
          ]
        )
      }

      const fileDurationSeconds =
        data.acceptedClaims.find((claim) => claim.durationSeconds != null && (claim.provider === 'tags' || claim.provider === 'filename'))?.durationSeconds ??
        data.acceptedClaims.find((claim) => claim.durationSeconds != null)?.durationSeconds ??
        null
      if (recordingId && data.audioHash) {
        await client.query(
          `
            INSERT INTO audio_assets(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT(audio_hash) DO UPDATE SET
              recording_id = EXCLUDED.recording_id,
              duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_assets.duration_seconds),
              assigned_by = EXCLUDED.assigned_by,
              confidence = EXCLUDED.confidence,
              updated_at = now()
          `,
          [data.audioHash, recordingId, fileDurationSeconds, data.assignmentMethod ?? 'manual', data.confidence ?? 0]
        )
      }

      await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [filename])
      for (const candidate of data.candidates) {
        await client.query(
          `
            INSERT INTO file_identification_candidates(
              filename, provider, entity_type, external_key, proposed_recording_id, score, disposition, payload_json, processed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
          `,
          [
            filename,
            candidate.provider,
            candidate.entityType,
            candidate.externalKey,
            candidate.proposedRecordingId,
            candidate.score,
            candidate.disposition,
            normalizeJsonText(candidate.payloadJson)
          ]
        )
      }

      await client.query(
        `
          INSERT INTO file_identification_state(
            filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            tag_artist, tag_title, tag_version, chosen_claim_id,
            identify_version, explanation_json, verified_at, error_message, processed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NULL, NULL, now())
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            recording_id = excluded.recording_id,
            audio_hash = excluded.audio_hash,
            status = excluded.status,
            assignment_method = excluded.assignment_method,
            confidence = excluded.confidence,
            parsed_artist = excluded.parsed_artist,
            parsed_title = excluded.parsed_title,
            parsed_version = excluded.parsed_version,
            parsed_year = excluded.parsed_year,
            tag_artist = excluded.tag_artist,
            tag_title = excluded.tag_title,
            tag_version = excluded.tag_version,
            chosen_claim_id = excluded.chosen_claim_id,
            identify_version = excluded.identify_version,
            explanation_json = excluded.explanation_json,
            verified_at = file_identification_state.verified_at,
            error_message = NULL,
            processed_at = now()
        `,
        [
          filename,
          data.filesize,
          data.mtimeMs,
          recordingId,
          data.audioHash,
          data.status,
          data.assignmentMethod,
          data.confidence,
          data.parsedArtist,
          data.parsedTitle,
          data.parsedVersion,
          data.parsedYear,
          data.tagArtist,
          data.tagTitle,
          data.tagVersion,
          data.chosenClaimId ?? (data.chosenExternalKey ? (claimIds.get(data.chosenExternalKey) ?? null) : null),
          IDENTIFY_VERSION,
          normalizeJsonText(data.explanationJson)
        ]
      )
      if (recordingId) await this.materializeRecordingDurations([recordingId], client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    await this.refreshIdentificationQueueCounts()
    this.emitStatus()
  }

  public async saveIdentificationError(
    filename: string,
    data: { filesize: number; mtimeMs: number; errorMessage: string }
  ): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO file_identification_state(
          filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
          parsed_artist, parsed_title, parsed_version, parsed_year,
          tag_artist, tag_title, tag_version, chosen_claim_id,
          identify_version, explanation_json, verified_at, error_message, processed_at
        ) VALUES ($1, $2, $3, NULL, NULL, 'error', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $4, NULL, NULL, $5, now())
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          status = 'error',
          assignment_method = NULL,
          confidence = NULL,
          chosen_claim_id = NULL,
          identify_version = excluded.identify_version,
          explanation_json = NULL,
          verified_at = file_identification_state.verified_at,
          error_message = excluded.error_message,
          processed_at = now()
      `,
      [filename, data.filesize, data.mtimeMs, IDENTIFY_VERSION, data.errorMessage]
    )
    await this.refreshIdentificationQueueCounts()
    this.emitStatus()
  }

  public async readFileSnapshot(filename: string): Promise<{ filesize: number; mtimeMs: number } | null> {
    await this.ensureReady()
    const row = (
      await this.pool.query<{ filesize: number | bigint; mtimems: number | bigint }>(
        `
          SELECT collection_files.filesize, collection_file_state.mtime_ms AS mtimeMs
          FROM collection_files
          JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
          WHERE collection_files.filename = $1
        `,
        [filename]
      )
    ).rows[0]
    return row ? { filesize: toNumber(row.filesize), mtimeMs: toNumber(row.mtimems) } : null
  }

  public async listCollectionFileState(): Promise<LocalSongFileState[]> {
    await this.ensureReady()
    return (
      await this.pool.query<{ filename: string; filesize: number | bigint; mtimems: number | bigint }>(
        `
          SELECT collection_files.filename, collection_files.filesize, collection_file_state.mtime_ms AS mtimeMs
          FROM collection_files
          JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
          ORDER BY collection_files.filename
        `
      )
    ).rows.map((row) => ({ filename: row.filename, filesize: toNumber(row.filesize), mtimeMs: toNumber(row.mtimems) }))
  }

  public async applySongsOnlySyncPlan(plan: SongsOnlySyncPlan): Promise<void> {
    await this.ensureReady()
    const changed = [...plan.inserted, ...plan.updated]
    if (changed.length === 0 && plan.deleted.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.archiveIdentificationStateWithClient(client, [...changed.map((item) => item.filename), ...plan.deleted])
      for (const item of changed) {
        await client.query(
          `
            INSERT INTO collection_files(filename, filesize)
            VALUES ($1, $2)
            ON CONFLICT(filename) DO UPDATE SET filesize = excluded.filesize
          `,
          [item.filename, item.filesize]
        )
        await client.query(
          `
            INSERT INTO collection_file_state(filename, mtime_ms)
            VALUES ($1, $2)
            ON CONFLICT(filename) DO UPDATE SET mtime_ms = excluded.mtime_ms
          `,
          [item.filename, item.mtimeMs]
        )
        await client.query(
          `
            INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
            VALUES ($1, $2, $3, $4, NULL, 'pending', NULL, NULL)
            ON CONFLICT(filename) DO UPDATE SET
              filesize = excluded.filesize,
              mtime_ms = excluded.mtime_ms,
              hash_version = excluded.hash_version,
              audio_hash = NULL,
              status = 'pending',
              error_message = NULL,
              processed_at = NULL
          `,
          [item.filename, item.filesize, item.mtimeMs, AUDIO_HASH_VERSION]
        )
        await client.query(`DELETE FROM file_tag_state WHERE filename = $1`, [item.filename])
        if (!(await this.restoreArchivedIdentificationWithClient(client, item.filename, item))) {
          await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [item.filename])
          await client.query(`DELETE FROM file_identification_state WHERE filename = $1`, [item.filename])
        }
      }
      for (const filename of plan.deleted) {
        await client.query(`DELETE FROM collection_files WHERE filename = $1`, [filename])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    this.status.itemCount = await this.readItemCount()
    await this.refreshImportQueueCounts()
    await this.refreshIdentificationQueueCounts()
    this.emitStatus()
  }

  public async saveFileTagState(filename: string, data: FileTagStateInput): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO file_tag_state(
          filename, filesize, mtime_ms, tag_version, source,
          artist, title, version, album, year, label, catalog_number, track_position,
          discogs_release_id, discogs_track_position, raw_json, error_message, processed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, now())
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          tag_version = excluded.tag_version,
          source = excluded.source,
          artist = excluded.artist,
          title = excluded.title,
          version = excluded.version,
          album = excluded.album,
          year = excluded.year,
          label = excluded.label,
          catalog_number = excluded.catalog_number,
          track_position = excluded.track_position,
          discogs_release_id = excluded.discogs_release_id,
          discogs_track_position = excluded.discogs_track_position,
          raw_json = excluded.raw_json,
          error_message = excluded.error_message,
          processed_at = now()
      `,
      [
        filename,
        data.filesize,
        data.mtimeMs,
        LOCAL_TAG_VERSION,
        data.source,
        data.artist,
        data.title,
        data.version,
        data.album,
        data.year,
        data.label,
        data.catalogNumber,
        data.trackPosition,
        data.discogsReleaseId,
        data.discogsTrackPosition,
        normalizeJsonText(data.rawJson),
        data.errorMessage
      ]
    )
  }

  public async findRecordingByAudioHash(audioHash: string): Promise<{ recordingId: number; canonical: RecordingCanonical | null } | null> {
    await this.ensureReady()
    const row = (
      await this.pool.query<{
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
          FROM audio_assets
          JOIN recordings ON recordings.id = audio_assets.recording_id
          WHERE audio_assets.audio_hash = $1 AND recordings.merged_into_recording_id IS NULL
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

  public async findSourceClaimMatches(externalKeys: string[]): Promise<SourceClaimMatch[]> {
    await this.ensureReady()
    const keys = [...new Set(externalKeys.filter(Boolean))]
    if (keys.length === 0) return []
    return (
      await this.pool.query<{
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
      canonical: toCanonical(row.canonicalartist, row.canonicaltitle, row.canonicalversion, row.canonicalyear) ?? {
        artist: null,
        title: null,
        version: null,
        year: null
      }
    }))
  }

  public async listRecordingsForMatching(): Promise<RecordingMatchRow[]> {
    await this.ensureReady()
    const recordings = (
      await this.pool.query<{
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
      await this.pool.query<{
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
      canonical: toCanonical(row.canonicalartist, row.canonicaltitle, row.canonicalversion, row.canonicalyear) ?? {
        artist: null,
        title: null,
        version: null,
        year: null
      },
      confidence: row.confidence,
      reviewState: row.reviewstate,
      metadataLocked: row.metadatalocked,
      mergedIntoRecordingId: row.mergedintorecordingid == null ? null : toNumber(row.mergedintorecordingid),
      claims: claimsByRecording.get(toNumber(row.id)) ?? []
    }))
  }

  public async listRecordings(query: string = ''): Promise<RecordingSummary[]> {
    await this.ensureReady()
    const normalizedQuery = buildFtsQuery(query)
    const values: unknown[] = []
    const whereSql = normalizedQuery
      ? `WHERE recordings.merged_into_recording_id IS NULL AND to_tsvector('simple', coalesce(recordings.canonical_artist,'') || ' ' || coalesce(recordings.canonical_title,'') || ' ' || coalesce(recordings.canonical_version,'')) @@ plainto_tsquery('simple', $1)`
      : `WHERE recordings.merged_into_recording_id IS NULL`
    if (normalizedQuery) values.push(normalizedQuery)
    return (
      await this.pool.query<{
        id: number | bigint
        canonicalartist: string | null
        canonicaltitle: string | null
        canonicalversion: string | null
        canonicalyear: string | null
        confidence: number
        reviewstate: RecordingSummary['reviewState']
        metadatalocked: boolean
        mergedintorecordingid: number | bigint | null
        durationseconds: number | null
        filecount: number | bigint
        claimcount: number | bigint
      }>(
        `
          SELECT
            recordings.id,
            recordings.canonical_artist AS canonicalArtist,
            recordings.canonical_title AS canonicalTitle,
            recordings.canonical_version AS canonicalVersion,
            recordings.canonical_year AS canonicalYear,
            recordings.confidence,
            recordings.review_state AS reviewState,
            recordings.metadata_locked AS metadataLocked,
            recordings.merged_into_recording_id AS mergedIntoRecordingId,
            recordings.duration_seconds AS durationSeconds,
            COUNT(DISTINCT file_identification_state.filename) AS fileCount,
            COUNT(DISTINCT recording_source_claims.id) AS claimCount
          FROM recordings
          LEFT JOIN file_identification_state ON file_identification_state.recording_id = recordings.id
          LEFT JOIN recording_source_claims ON recording_source_claims.recording_id = recordings.id
          ${whereSql}
          GROUP BY recordings.id
          ORDER BY COUNT(DISTINCT file_identification_state.filename) DESC, recordings.id DESC
        `,
        values
      )
    ).rows.map((row) => ({
      id: toNumber(row.id),
      canonical: toCanonical(row.canonicalartist, row.canonicaltitle, row.canonicalversion, row.canonicalyear) ?? {
        artist: null,
        title: null,
        version: null,
        year: null
      },
      confidence: row.confidence,
      reviewState: row.reviewstate,
      metadataLocked: row.metadatalocked,
      mergedIntoRecordingId: row.mergedintorecordingid == null ? null : toNumber(row.mergedintorecordingid),
      durationSeconds: row.durationseconds == null ? null : Number(row.durationseconds),
      fileCount: toNumber(row.filecount),
      claimCount: toNumber(row.claimcount)
    }))
  }

  public async getRecording(recordingId: number): Promise<RecordingDetails | null> {
    await this.ensureReady()
    const summary = (await this.listRecordings()).find((item) => item.id === recordingId) ?? null
    if (!summary) return null

    const [sourceClaims, files] = await Promise.all([
      this.pool.query<{
        id: number | bigint
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
            id,
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
          WHERE recording_id = $1
          ORDER BY confidence DESC, id DESC
        `,
        [recordingId]
      ),
      this.pool.query<{
        filename: string
        status: IdentificationStatus
        confidence: number | null
        assignmentmethod: IdentificationAssignmentMethod | null
      }>(
        `
          SELECT filename, status, confidence, assignment_method AS assignmentMethod
          FROM file_identification_state
          WHERE recording_id = $1
          ORDER BY lower(filename)
        `,
        [recordingId]
      )
    ])

    return {
      ...summary,
      sourceClaims: sourceClaims.rows.map((row) => ({
        id: toNumber(row.id),
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
      })),
      files: files.rows.map((row) => ({
        filename: row.filename,
        status: row.status,
        confidence: row.confidence,
        assignmentMethod: row.assignmentmethod
      }))
    }
  }

  public async reviewIdentification(
    filename: string,
    action: 'accept' | 'reject' | 'create_recording',
    candidateId?: number | null
  ): Promise<FileIdentificationState | null> {
    await this.ensureReady()
    if (action === 'reject') {
      if (!candidateId) return null
      await this.pool.query(
        `
          UPDATE file_identification_candidates
          SET disposition = 'rejected', processed_at = now()
          WHERE filename = $1 AND id = $2
        `,
        [filename, candidateId]
      )
      await this.pool.query(
        `
          UPDATE file_identification_state
          SET status = 'needs_review', assignment_method = NULL, confidence = NULL, recording_id = NULL, chosen_claim_id = NULL, verified_at = NULL, processed_at = now()
          WHERE filename = $1
        `,
        [filename]
      )
    } else {
      const item = await this.getItem(filename)
      if (!item?.identification) return null
      const selectedCandidate =
        action === 'accept' && candidateId
          ? item.identification.candidates.find((candidate) => candidate.id === candidateId) ?? null
          : null
      const payload = selectedCandidate?.payloadJson ? (JSON.parse(selectedCandidate.payloadJson) as RecordingClaimInput) : null
      let recordingId = selectedCandidate?.proposedRecordingId ?? null
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        if (!recordingId) {
          const canonical =
            selectedCandidate?.recordingCanonical ??
            toCanonical(
              payload?.artist ?? item.identification.tagArtist ?? item.identification.parsedArtist,
              payload?.title ?? item.identification.tagTitle ?? item.identification.parsedTitle,
              payload?.version ?? item.identification.tagVersion ?? item.identification.parsedVersion,
              payload?.year ?? item.identification.parsedYear
            )
          if (!canonical) {
            await client.query('ROLLBACK')
            return await this.getItem(filename).then((next) => next?.identification ?? null)
          }
          const created = (
            await client.query<{ id: number | bigint }>(
              `
                INSERT INTO recordings(
                  canonical_artist, canonical_title, canonical_version, canonical_year, canonical_norm_key,
                  confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
                ) VALUES ($1, $2, $3, $4, $5, 100, 'confirmed', TRUE, NULL, now())
                RETURNING id
              `,
              [canonical.artist, canonical.title, canonical.version, canonical.year, buildCanonicalNormKey(canonical)]
            )
          ).rows[0]
          recordingId = created ? toNumber(created.id) : null
        }
        if (recordingId == null) throw new Error('Recording could not be created.')

        if (payload) {
          await client.query(
            `
              INSERT INTO recording_source_claims(
                recording_id, provider, entity_type, external_key,
                artist, title, version, release_title, track_position, year, duration_seconds,
                confidence, raw_json, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 100, $12::jsonb, now())
              ON CONFLICT(provider, entity_type, external_key) DO UPDATE SET
                recording_id = EXCLUDED.recording_id,
                duration_seconds = COALESCE(EXCLUDED.duration_seconds, recording_source_claims.duration_seconds),
                confidence = GREATEST(recording_source_claims.confidence, EXCLUDED.confidence),
                raw_json = COALESCE(EXCLUDED.raw_json, recording_source_claims.raw_json),
                updated_at = now()
            `,
            [
              recordingId,
              payload.provider,
              payload.entityType,
              payload.externalKey,
              payload.artist,
              payload.title,
              payload.version,
              payload.releaseTitle,
              payload.trackPosition,
              payload.year,
              payload.durationSeconds,
              normalizeJsonText(payload.rawJson)
            ]
          )
        }
        if (item.fileAudioState?.audioHash) {
          await client.query(
            `
              INSERT INTO audio_assets(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
              VALUES ($1, $2, $3, 'manual', 100, now())
              ON CONFLICT(audio_hash) DO UPDATE SET
                recording_id = EXCLUDED.recording_id,
                duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_assets.duration_seconds),
                assigned_by = 'manual',
                confidence = 100,
                updated_at = now()
            `,
            [item.fileAudioState.audioHash, recordingId, item.parsedAudioAnalysis?.durationSeconds ?? null]
          )
        }
        await client.query(
          `
            UPDATE file_identification_candidates
            SET disposition = CASE WHEN id = $2 THEN 'accepted' ELSE disposition END, processed_at = now()
            WHERE filename = $1
          `,
          [filename, candidateId ?? 0]
        )
        await client.query(
          `
            UPDATE file_identification_state
            SET
              recording_id = $2,
              status = 'ready',
              assignment_method = 'manual',
              confidence = 100,
              chosen_claim_id = NULL,
              verified_at = now(),
              error_message = NULL,
              processed_at = now()
            WHERE filename = $1
          `,
          [filename, recordingId]
        )
        await this.materializeRecordingDurations([recordingId], client)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    await this.refreshIdentificationQueueCounts()
    this.emitStatus()
    const item = await this.getItem(filename)
    return item?.identification ?? null
  }

  public async assignRecording(input: {
    recordingId?: number | null
    filenames: string[]
    create?: boolean
    canonical?: Partial<RecordingCanonical> | null
  }): Promise<RecordingDetails | null> {
    await this.ensureReady()
    const filenames = [...new Set((input.filenames ?? []).map(normalizeFilename).filter(Boolean))]
    if (filenames.length === 0) return null
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      let recordingId = input.recordingId ?? null
      const canonical = toCanonical(
        input.canonical?.artist,
        input.canonical?.title,
        input.canonical?.version,
        input.canonical?.year
      )
      if (!recordingId || input.create) {
        const seed =
          canonical ??
          (
            await this.pool.query<{
              parsedartist: string | null
              parsedtitle: string | null
              parsedversion: string | null
              parsedyear: string | null
            }>(
              `
                SELECT
                  parsed_artist AS parsedArtist,
                  parsed_title AS parsedTitle,
                  parsed_version AS parsedVersion,
                  parsed_year AS parsedYear
                FROM file_identification_state
                WHERE filename = $1
              `,
              [filenames[0]]
            )
          ).rows.map((row) => toCanonical(row.parsedartist, row.parsedtitle, row.parsedversion, row.parsedyear))[0] ?? {
            artist: null,
            title: null,
            version: null,
            year: null
          }
        const created = (
          await client.query<{ id: number | bigint }>(
            `
              INSERT INTO recordings(
                canonical_artist, canonical_title, canonical_version, canonical_year, canonical_norm_key,
                confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
              ) VALUES ($1, $2, $3, $4, $5, 100, 'confirmed', TRUE, NULL, now())
              RETURNING id
            `,
            [seed.artist, seed.title, seed.version, seed.year, buildCanonicalNormKey(seed)]
          )
        ).rows[0]
        recordingId = created ? toNumber(created.id) : null
      } else if (canonical) {
        await client.query(
          `
            UPDATE recordings
            SET
              canonical_artist = COALESCE($2, canonical_artist),
              canonical_title = COALESCE($3, canonical_title),
              canonical_version = COALESCE($4, canonical_version),
              canonical_year = COALESCE($5, canonical_year),
              canonical_norm_key = $6,
              review_state = 'confirmed',
              metadata_locked = TRUE,
              updated_at = now()
            WHERE id = $1
          `,
          [recordingId, canonical.artist, canonical.title, canonical.version, canonical.year, buildCanonicalNormKey(canonical)]
        )
      }
      if (!recordingId) throw new Error('Recording could not be assigned.')
      for (const filename of filenames) {
        await client.query(
          `
            UPDATE file_identification_state
            SET
              recording_id = $2,
              status = 'ready',
              assignment_method = 'manual',
              confidence = 100,
              chosen_claim_id = NULL,
              verified_at = now(),
              processed_at = now(),
              error_message = NULL
            WHERE filename = $1
          `,
          [filename, recordingId]
        )
        const assetRow = (
          await client.query<{ audiohash: string | null; durationseconds: number | null }>(
            `
              SELECT file_identification_state.audio_hash AS audioHash, NULLIF(NULLIF(audio_analysis_cache.analysis_json, '')::jsonb->>'durationSeconds', '')::double precision AS durationSeconds
              FROM file_identification_state
              LEFT JOIN audio_analysis_cache
                ON audio_analysis_cache.audio_hash = file_identification_state.audio_hash
               AND audio_analysis_cache.analysis_version = $2
              WHERE file_identification_state.filename = $1
            `,
            [filename, AUDIO_ANALYSIS_VERSION]
          )
        ).rows[0]
        if (assetRow?.audiohash) {
          await client.query(
            `
              INSERT INTO audio_assets(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
              VALUES ($1, $2, $3, 'manual', 100, now())
              ON CONFLICT(audio_hash) DO UPDATE SET
                recording_id = EXCLUDED.recording_id,
                duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_assets.duration_seconds),
                assigned_by = 'manual',
                confidence = 100,
                updated_at = now()
            `,
            [assetRow.audiohash, recordingId, assetRow.durationseconds]
          )
        }
      }
      await this.materializeRecordingDurations([recordingId], client)
      await client.query('COMMIT')
      await this.refreshIdentificationQueueCounts()
      this.emitStatus()
      return await this.getRecording(recordingId)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  public async assignDiscogsTrack(filenameInput: string, match: DiscogsTrackMatch): Promise<RecordingDetails | null> {
    await this.ensureReady()
    const filename = normalizeFilename(filenameInput)
    const canonical = toCanonical(match.artist, match.title, match.version, match.year)
    if (!filename || !canonical) return null
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const normKey = buildCanonicalNormKey(canonical)
      let recordingId = (
        await client.query<{ id: number | bigint }>(
          `
            SELECT id
            FROM recordings
            WHERE canonical_norm_key = $1 AND review_state <> 'merged'
            ORDER BY metadata_locked DESC, confidence DESC, id
            LIMIT 1
          `,
          [normKey]
        )
      ).rows[0]?.id
      if (!recordingId) {
        recordingId = (
          await client.query<{ id: number | bigint }>(
            `
              INSERT INTO recordings(
                canonical_artist, canonical_title, canonical_version, canonical_year, canonical_norm_key,
                confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
              ) VALUES ($1, $2, $3, $4, $5, 100, 'confirmed', TRUE, NULL, now())
              RETURNING id
            `,
            [canonical.artist, canonical.title, canonical.version, canonical.year, normKey]
          )
        ).rows[0]?.id
      }
      if (!recordingId) throw new Error('Recording could not be created.')
      const id = toNumber(recordingId)
      const claimId = (
        await client.query<{ id: number | bigint }>(
          `
            INSERT INTO recording_source_claims(
              recording_id, provider, entity_type, external_key,
              artist, title, version, release_title, track_position, year, duration_seconds,
              confidence, raw_json, updated_at
            ) VALUES ($1, 'discogs', 'release_track', $2, $3, $4, $5, $6, $7, $8, $9, 100, $10::jsonb, now())
            ON CONFLICT(provider, entity_type, external_key) DO UPDATE SET
              recording_id = EXCLUDED.recording_id,
              artist = EXCLUDED.artist,
              title = EXCLUDED.title,
              version = EXCLUDED.version,
              release_title = EXCLUDED.release_title,
              track_position = EXCLUDED.track_position,
              year = COALESCE(EXCLUDED.year, recording_source_claims.year),
              duration_seconds = COALESCE(EXCLUDED.duration_seconds, recording_source_claims.duration_seconds),
              confidence = GREATEST(recording_source_claims.confidence, EXCLUDED.confidence),
              raw_json = EXCLUDED.raw_json,
              updated_at = now()
            RETURNING id
          `,
          [
            id,
            buildDiscogsExternalKey(match),
            match.artist,
            match.title,
            match.version,
            match.releaseTitle,
            match.trackPosition,
            match.year,
            match.durationSeconds ?? null,
            JSON.stringify(match)
          ]
        )
      ).rows[0]?.id
      const updatedFile = await client.query(
        `
          UPDATE file_identification_state
          SET recording_id = $2, status = 'ready', assignment_method = 'manual', confidence = 100,
              chosen_claim_id = $3, verified_at = now(), processed_at = now(), error_message = NULL
          WHERE filename = $1
          RETURNING filename
        `,
        [filename, id, claimId ? toNumber(claimId) : null]
      )
      if (updatedFile.rowCount !== 1) throw new Error('File identification state was not found.')
      const assetRow = (
        await client.query<{ audiohash: string | null; durationseconds: number | null }>(
          `
            SELECT file_identification_state.audio_hash AS audioHash, NULLIF(NULLIF(audio_analysis_cache.analysis_json, '')::jsonb->>'durationSeconds', '')::double precision AS durationSeconds
            FROM file_identification_state
            LEFT JOIN audio_analysis_cache
              ON audio_analysis_cache.audio_hash = file_identification_state.audio_hash
             AND audio_analysis_cache.analysis_version = $2
            WHERE file_identification_state.filename = $1
          `,
          [filename, AUDIO_ANALYSIS_VERSION]
        )
      ).rows[0]
      if (assetRow?.audiohash) {
        await client.query(
          `
            INSERT INTO audio_assets(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
            VALUES ($1, $2, $3, 'manual', 100, now())
            ON CONFLICT(audio_hash) DO UPDATE SET
              recording_id = EXCLUDED.recording_id,
              duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_assets.duration_seconds),
              assigned_by = 'manual',
              confidence = 100,
              updated_at = now()
          `,
          [assetRow.audiohash, id, assetRow.durationseconds]
        )
      }
      await this.materializeRecordingDurations([id], client)
      await client.query('COMMIT')
      return await this.getRecording(id)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  public async assignDiscogsTrackToRecording(recordingId: number, match: DiscogsTrackMatch): Promise<RecordingDetails | null> {
    await this.ensureReady()
    const canonical = toCanonical(match.artist, match.title, match.version, match.year)
    if (!Number.isFinite(recordingId) || recordingId <= 0 || !canonical) return null
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const updated = await client.query(
        `
          UPDATE recordings
          SET canonical_artist = $2, canonical_title = $3, canonical_version = $4, canonical_year = $5,
              canonical_norm_key = $6, confidence = 100, review_state = 'confirmed',
              metadata_locked = TRUE, updated_at = now()
          WHERE id = $1 AND review_state <> 'merged'
        `,
        [recordingId, canonical.artist, canonical.title, canonical.version, canonical.year, buildCanonicalNormKey(canonical)]
      )
      if (updated.rowCount !== 1) throw new Error('Recording was not found.')
      const claimId = (
        await client.query<{ id: number | bigint }>(
          `
            INSERT INTO recording_source_claims(
              recording_id, provider, entity_type, external_key,
              artist, title, version, release_title, track_position, year, duration_seconds,
              confidence, raw_json, updated_at
            ) VALUES ($1, 'discogs', 'release_track', $2, $3, $4, $5, $6, $7, $8, $9, 100, $10::jsonb, now())
            ON CONFLICT(provider, entity_type, external_key) DO UPDATE SET
              recording_id = EXCLUDED.recording_id,
              artist = EXCLUDED.artist,
              title = EXCLUDED.title,
              version = EXCLUDED.version,
              release_title = EXCLUDED.release_title,
              track_position = EXCLUDED.track_position,
              year = COALESCE(EXCLUDED.year, recording_source_claims.year),
              duration_seconds = COALESCE(EXCLUDED.duration_seconds, recording_source_claims.duration_seconds),
              confidence = GREATEST(recording_source_claims.confidence, EXCLUDED.confidence),
              raw_json = EXCLUDED.raw_json,
              updated_at = now()
            RETURNING id
          `,
          [
            recordingId,
            buildDiscogsExternalKey(match),
            match.artist,
            match.title,
            match.version,
            match.releaseTitle,
            match.trackPosition,
            match.year,
            match.durationSeconds ?? null,
            JSON.stringify(match)
          ]
        )
      ).rows[0]?.id
      await client.query(
        `
          UPDATE file_identification_state
          SET status = 'ready', assignment_method = 'manual', confidence = 100,
              chosen_claim_id = $2, verified_at = now(), processed_at = now(), error_message = NULL
          WHERE recording_id = $1
        `,
        [recordingId, claimId ? toNumber(claimId) : null]
      )
      await this.materializeRecordingDurations([recordingId], client)
      await client.query('COMMIT')
      return await this.getRecording(recordingId)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  public async mergeRecordings(sourceRecordingId: number, targetRecordingId: number): Promise<RecordingDetails | null> {
    await this.ensureReady()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const sourceClaims = (
        await client.query<{
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
            WHERE recording_id = $1
          `,
          [sourceRecordingId]
        )
      ).rows
      for (const claim of sourceClaims) {
        await client.query(
          `
            INSERT INTO recording_source_claims(
              recording_id, provider, entity_type, external_key,
              artist, title, version, release_title, track_position, year, duration_seconds,
              confidence, raw_json, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now())
            ON CONFLICT(provider, entity_type, external_key) DO UPDATE SET
              recording_id = EXCLUDED.recording_id,
              confidence = GREATEST(recording_source_claims.confidence, EXCLUDED.confidence),
              raw_json = COALESCE(EXCLUDED.raw_json, recording_source_claims.raw_json),
              updated_at = now()
          `,
          [
            targetRecordingId,
            claim.provider,
            claim.entitytype,
            claim.externalkey,
            claim.artist,
            claim.title,
            claim.version,
            claim.releasetitle,
            claim.trackposition,
            claim.year,
            claim.durationseconds,
            claim.confidence,
            claim.rawjson == null ? null : JSON.stringify(claim.rawjson)
          ]
        )
      }
      await client.query(`UPDATE audio_assets SET recording_id = $2, updated_at = now() WHERE recording_id = $1`, [sourceRecordingId, targetRecordingId])
      await client.query(
        `
          UPDATE file_identification_state
          SET recording_id = $2, assignment_method = COALESCE(assignment_method, 'manual'), processed_at = now()
          WHERE recording_id = $1
        `,
        [sourceRecordingId, targetRecordingId]
      )
      await client.query(
        `
          UPDATE recordings
          SET review_state = 'merged', merged_into_recording_id = $2, updated_at = now()
          WHERE id = $1
        `,
        [sourceRecordingId, targetRecordingId]
      )
      await this.materializeRecordingDurations([targetRecordingId, sourceRecordingId], client)
      await client.query('COMMIT')
      return await this.getRecording(targetRecordingId)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  public async readStoredAudioHash(filename: string): Promise<string | null> {
    await this.ensureReady()
    const row = (
      await this.pool.query<{ audiohash: string | null }>(
        `
          SELECT file_audio_state.audio_hash AS audioHash
          FROM file_audio_state
          JOIN collection_files ON collection_files.filename = file_audio_state.filename
          JOIN collection_file_state ON collection_file_state.filename = file_audio_state.filename
          WHERE file_audio_state.filename = $1
            AND file_audio_state.status = 'ready'
            AND file_audio_state.hash_version = $2
            AND file_audio_state.mtime_ms = collection_file_state.mtime_ms
            AND file_audio_state.filesize = collection_files.filesize
        `,
        [filename, AUDIO_HASH_VERSION]
      )
    ).rows[0]
    return row?.audiohash ?? null
  }

  public async saveStoredAudioHash(
    filename: string,
    data: { filesize: number; mtimeMs: number; audioHash: string }
  ): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
        VALUES ($1, $2, $3, $4, $5, 'ready', NULL, now())
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          hash_version = excluded.hash_version,
          audio_hash = excluded.audio_hash,
          status = 'ready',
          error_message = NULL,
          processed_at = now()
      `,
      [filename, data.filesize, data.mtimeMs, AUDIO_HASH_VERSION, data.audioHash]
    )
  }

  public async saveStoredAudioHashError(
    filename: string,
    data: { filesize: number; mtimeMs: number; errorMessage: string }
  ): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
        VALUES ($1, $2, $3, $4, NULL, 'error', $5, now())
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          hash_version = excluded.hash_version,
          audio_hash = NULL,
          status = 'error',
          error_message = excluded.error_message,
          processed_at = now()
      `,
      [filename, data.filesize, data.mtimeMs, AUDIO_HASH_VERSION, data.errorMessage]
    )
  }

  public async readStoredAudioAnalysis(audioHash: string): Promise<string | null> {
    await this.ensureReady()
    const row = (
      await this.pool.query<{ analysisjson: string | null }>(
        `
          SELECT analysis_json AS analysisJson
          FROM audio_analysis_cache
          WHERE audio_hash = $1 AND analysis_version = $2 AND analysis_json IS NOT NULL
        `,
        [audioHash, AUDIO_ANALYSIS_VERSION]
      )
    ).rows[0]
    return row?.analysisjson ?? null
  }

  private async readCachedAudioAnalysisByFilename(filename: string): Promise<AudioAnalysis | null> {
    const audioHash = await this.readStoredAudioHash(filename)
    if (!audioHash) return null
    const analysisJson = await this.readStoredAudioAnalysis(audioHash)
    if (!analysisJson) return null
    try {
      return JSON.parse(analysisJson) as AudioAnalysis
    } catch {
      return null
    }
  }

  private async readCollectionFilesize(filename: string): Promise<number | null> {
    const row = (
      await this.pool.query<{ filesize?: number | bigint }>(
        `
          SELECT filesize
          FROM collection_files
          WHERE filename = $1
        `,
        [filename]
      )
    ).rows[0]
    return row?.filesize == null ? null : toNumber(row.filesize)
  }

  private async findExistingCollectionFilenameByCanonical(canonical: RecordingCanonical | null, downloadPrefixes: string[]) {
    if (!canonical?.artist || !canonical.title) return null
    const normKey = buildCanonicalNormKey(canonical)
    if (!normKey) return null
    const prefixWhere = buildPrefixWhereClausePg('collection_files.filename', downloadPrefixes, 2)
    const rows = (await this.pool.query<{ filename: string }>(
      `
        SELECT collection_files.filename
        FROM collection_files
        JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
        JOIN recordings ON recordings.id = file_identification_state.recording_id
        WHERE recordings.merged_into_recording_id IS NULL
          AND recordings.canonical_norm_key = $1
          AND NOT (${prefixWhere.clause})
        ORDER BY lower(collection_files.filename)
        LIMIT 2
      `,
      [normKey, ...prefixWhere.params]
    )).rows
    return rows.length === 1 ? rows[0].filename : null
  }

  private async readFileQuality(filename: string, filesize: number | null) {
    if (filesize == null) return null
    const bitrateKbps = (await this.readCachedAudioAnalysisByFilename(filename))?.bitrateKbps ?? null
    return fileQualityFromExt(extname(filename), filesize, bitrateKbps)
  }

  public async saveStoredAudioAnalysis(audioHash: string, analysisJson: string): Promise<void> {
    await this.ensureReady()
    await this.pool.query(
      `
        INSERT INTO audio_analysis_cache(audio_hash, analysis_version, analysis_json, error_message, processed_at)
        VALUES ($1, $2, $3, NULL, now())
        ON CONFLICT(audio_hash, analysis_version) DO UPDATE SET
          analysis_json = excluded.analysis_json,
          error_message = NULL,
          processed_at = now()
      `,
      [audioHash, AUDIO_ANALYSIS_VERSION, analysisJson]
    )
  }

  public async invalidateAudioAnalysis(filename: string): Promise<boolean> {
    await this.ensureReady()
    const snapshot = await this.readFileSnapshot(filename)
    if (!snapshot) return false
    const existingHash = await this.readStoredAudioHash(filename)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `
          INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
          VALUES ($1, $2, $3, $4, NULL, 'pending', NULL, NULL)
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            hash_version = excluded.hash_version,
            audio_hash = NULL,
            status = 'pending',
            error_message = NULL,
            processed_at = NULL
        `,
        [filename, snapshot.filesize, snapshot.mtimeMs, AUDIO_HASH_VERSION]
      )
      if (existingHash) {
        await client.query(
          `
            DELETE FROM audio_analysis_cache
            WHERE audio_hash = $1 AND analysis_version = $2
          `,
          [existingHash, AUDIO_ANALYSIS_VERSION]
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    return true
  }

  private async syncDownloadAttemptFileLinksWithClient(
    client: PoolClient,
    removed: string[]
  ): Promise<Map<string, SyncChange>> {
    const linked = new Map<string, SyncChange>()
    for (const filename of removed) {
      await client.query(
        `UPDATE download_attempts SET local_filename = NULL, local_filesize = NULL, updated_at = now() WHERE local_filename = $1`,
        [filename]
      )
    }

    const prefixes = getDownloadFolderPrefixes(this.settings.downloadFolderPaths)
    if (prefixes.length === 0) return linked
    const prefixWhere = buildPrefixWhereClausePg('collection_files.filename', prefixes)
    const files = (await client.query<DownloadAttemptFileInput & { mtimems: number | bigint }>(
      `
        SELECT collection_files.filename, collection_files.filesize, collection_file_state.mtime_ms AS mtimeMs
        FROM collection_files
        JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
        WHERE ${prefixWhere.clause}
      `,
      prefixWhere.params
    )).rows
    const attempts = (await client.query<{
      id: number | bigint
      wantlistid: number | bigint | null
      status: DownloadAttemptFileLinkInput['status']
      expectedlocalfilename: string | null
      remotefilename: string | null
      remotesize: number | bigint | null
      localfilename: string | null
      localfilesize: number | bigint | null
    }>(
      `
        SELECT id, want_list_id AS wantListId, status, expected_local_filename AS expectedLocalFilename,
          remote_filename AS remoteFilename, remote_size AS remoteSize, local_filename AS localFilename, local_filesize AS localFilesize
        FROM download_attempts
        WHERE status IN ('queued', 'requested', 'downloading', 'downloaded', 'missing_local')
          AND (expected_local_filename IS NOT NULL OR remote_filename IS NOT NULL)
          AND (
            local_filename IS NULL
            OR (remote_size IS NOT NULL AND local_filesize IS DISTINCT FROM remote_size)
            OR NOT EXISTS (SELECT 1 FROM collection_files WHERE filename = download_attempts.local_filename)
          )
      `
    )).rows.map((row): DownloadAttemptFileLinkInput => ({
      id: toNumber(row.id),
      wantListId: row.wantlistid == null ? null : toNumber(row.wantlistid),
      status: row.status,
      expectedLocalFilename: row.expectedlocalfilename,
      remoteFilename: row.remotefilename,
      remoteSize: row.remotesize == null ? null : toNumber(row.remotesize),
      localFilename: row.localfilename,
      localFilesize: row.localfilesize == null ? null : toNumber(row.localfilesize)
    }))
    const fileState = new Map(files.map((file) => [file.filename, { filesize: toNumber(file.filesize), mtimeMs: toNumber(file.mtimems) }]))
    for (const link of planDownloadAttemptFileLinks(attempts, files.map((file) => ({ filename: file.filename, filesize: toNumber(file.filesize) })))) {
      const row = (await client.query<{ id: number | string; wantlistid: number | string | null }>(
        `
          UPDATE download_attempts target
          SET local_filename = $2,
              local_filesize = $3,
              status = 'downloaded',
              origin_recording_id = COALESCE(target.origin_recording_id, (SELECT recording_id FROM want_list WHERE id = target.want_list_id)),
              origin_source_collection_filename = COALESCE(target.origin_source_collection_filename, (SELECT source_collection_filename FROM want_list WHERE id = target.want_list_id)),
              completed_at = COALESCE(target.completed_at, now()),
              error_message = NULL,
              updated_at = now()
          WHERE target.id = $1
            AND (target.local_filename IS DISTINCT FROM $2 OR target.local_filesize IS DISTINCT FROM $3 OR target.status <> 'downloaded')
          RETURNING target.id, target.want_list_id AS wantlistid
        `,
        [link.attemptId, link.filename, link.filesize]
      )).rows[0]
      if (!row) continue
      const state = fileState.get(link.filename)
      if (state) linked.set(link.filename, state)
      if (row.wantlistid != null) {
        await client.query(
          `UPDATE want_list SET pipeline_status = 'downloaded', selected_download_id = COALESCE(selected_download_id, $2), updated_at = now() WHERE id = $1`,
          [toNumber(row.wantlistid), toNumber(row.id)]
        )
      }
    }
    return linked
  }

  private async readDownloadAttemptOriginWithClient(client: PoolClient, filename: string): Promise<DownloadAttemptOrigin | null> {
    const row = (await client.query<DownloadAttemptOrigin>(
      `
        SELECT
          COALESCE(download_attempts.origin_recording_id, want_list.recording_id) AS "recordingId",
          origin_artist AS "artist",
          origin_title AS "title",
          origin_version AS "version",
          origin_year AS "year",
          COALESCE(download_attempts.origin_source_collection_filename, want_list.source_collection_filename) AS "sourceCollectionFilename"
        FROM download_attempts
        LEFT JOIN want_list ON want_list.id = download_attempts.want_list_id
        WHERE local_filename = $1
        ORDER BY completed_at DESC NULLS LAST, download_attempts.updated_at DESC, download_attempts.id DESC
        LIMIT 1
      `,
      [filename]
    )).rows[0]
    return row ?? null
  }

  private async syncImportReviewCacheWithClient(
    client: PoolClient,
    changed: Map<string, SyncChange>,
    removed: string[]
  ): Promise<boolean> {
    const changedDownloads = [...changed.entries()].filter(([filename]) =>
      isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)
    )
    const removedDownloads = removed.filter((filename) =>
      isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)
    )
    if (changedDownloads.length === 0 && removedDownloads.length === 0) return false

    for (const [filename, change] of changedDownloads) {
      const parsed = parseImportFilename(filename)
      const origin = await this.readDownloadAttemptOriginWithClient(client, filename)
      await client.query(
        `
          INSERT INTO import_review_cache(
            filename, filesize, mtime_ms, review_version, status,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            review_json, error_message, processed_at
          ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, NULL, NULL, NULL)
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            review_version = excluded.review_version,
            status = 'pending',
            parsed_artist = excluded.parsed_artist,
            parsed_title = excluded.parsed_title,
            parsed_version = excluded.parsed_version,
            parsed_year = excluded.parsed_year,
            review_json = NULL,
            error_message = NULL,
            processed_at = NULL
        `,
        [
          filename,
          change.filesize,
          change.mtimeMs,
          IMPORT_REVIEW_VERSION,
          origin?.artist ?? parsed?.artist ?? null,
          origin?.title ?? parsed?.title ?? null,
          origin?.version ?? parsed?.version ?? null,
          origin?.year ?? parsed?.year ?? null
        ]
      )
    }

    for (const filename of removedDownloads) {
      await client.query(`DELETE FROM import_review_cache WHERE filename = $1`, [filename])
    }

    return true
  }

  private async syncIdentificationStateWithClient(
    client: PoolClient,
    changed: Map<string, SyncChange>,
    removed: string[]
  ): Promise<boolean> {
    if (changed.size === 0 && removed.length === 0) return false

    for (const [filename, change] of changed) {
      if (await this.restoreArchivedIdentificationWithClient(client, filename, change)) continue
      const parsed = parseImportFilename(filename)
      const origin = isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)
        ? await this.readDownloadAttemptOriginWithClient(client, filename)
        : null
      const seed = buildDownloadOriginIdentificationSeed(origin, parsed)
      await client.query(
        `
          INSERT INTO file_identification_state(
            filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            tag_artist, tag_title, tag_version, chosen_claim_id,
            identify_version, explanation_json, verified_at, error_message, processed_at
          ) VALUES ($1, $2, $3, $4::bigint, NULL, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, NULL, $12, NULL, CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END, NULL, CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END)
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            audio_hash = NULL,
            recording_id = excluded.recording_id,
            status = excluded.status,
            assignment_method = excluded.assignment_method,
            confidence = excluded.confidence,
            parsed_artist = excluded.parsed_artist,
            parsed_title = excluded.parsed_title,
            parsed_version = excluded.parsed_version,
            parsed_year = excluded.parsed_year,
            tag_artist = NULL,
            tag_title = NULL,
            tag_version = NULL,
            chosen_claim_id = NULL,
            identify_version = excluded.identify_version,
            explanation_json = NULL,
            verified_at = excluded.verified_at,
            error_message = NULL,
            processed_at = excluded.processed_at
        `,
        [
          filename,
          change.filesize,
          change.mtimeMs,
          seed.recordingId,
          seed.status,
          seed.assignmentMethod,
          seed.confidence,
          seed.parsedArtist,
          seed.parsedTitle,
          seed.parsedVersion,
          seed.parsedYear,
          IDENTIFY_VERSION
        ]
      )
      await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [filename])
    }

    return true
  }

  private async syncFileAnalysisStateWithClient(
    client: PoolClient,
    changed: Map<string, SyncChange>,
    removed: string[]
  ): Promise<void> {
    for (const [filename, change] of changed) {
      await client.query(
        `
          INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
          VALUES ($1, $2, $3, $4, NULL, 'pending', NULL, NULL)
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            hash_version = excluded.hash_version,
            audio_hash = NULL,
            status = 'pending',
            error_message = NULL,
            processed_at = NULL
        `,
        [filename, change.filesize, change.mtimeMs, AUDIO_HASH_VERSION]
      )
    }

    for (const filename of removed) {
      await client.query(`DELETE FROM file_audio_state WHERE filename = $1`, [filename])
    }
  }

  private async readItemCount(): Promise<number> {
    const row = (await this.pool.query<{ total: number | bigint }>('SELECT COUNT(*) AS total FROM collection_files')).rows[0]
    return row ? toNumber(row.total) : 0
  }

  private async refreshImportQueueCounts(): Promise<void> {
    const rows = (
      await this.pool.query<{ status: string; total: number | bigint }>(
        `
          SELECT status, COUNT(*) AS total
          FROM import_review_cache
          GROUP BY status
        `
      )
    ).rows

    this.status.importPendingCount = 0
    this.status.importProcessingCount = 0
    this.status.importErrorCount = 0
    for (const row of rows) {
      if (row.status === 'pending') this.status.importPendingCount = toNumber(row.total)
      if (row.status === 'processing') this.status.importProcessingCount = toNumber(row.total)
      if (row.status === 'error') this.status.importErrorCount = toNumber(row.total)
    }
  }

  private async refreshIdentificationQueueCounts(): Promise<void> {
    const rows = (
      await this.pool.query<{ status: string; total: number | bigint }>(
        `
          SELECT status, COUNT(*) AS total
          FROM file_identification_state
          GROUP BY status
        `
      )
    ).rows

    this.status.identificationPendingCount = 0
    this.status.identificationProcessingCount = 0
    this.status.identificationNeedsReviewCount = 0
    this.status.identificationErrorCount = 0
    for (const row of rows) {
      if (row.status === 'pending') this.status.identificationPendingCount = toNumber(row.total)
      if (row.status === 'processing') this.status.identificationProcessingCount = toNumber(row.total)
      if (row.status === 'needs_review') this.status.identificationNeedsReviewCount = toNumber(row.total)
      if (row.status === 'error') this.status.identificationErrorCount = toNumber(row.total)
    }
  }

  private scheduleDebouncedSync(): void {
    if (this.disposed) {
      return
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.syncNow()
    }, this.debounceMs)
  }

  private emitStatus(): void {
    const snapshot = this.getStatus()
    this.onUpdated?.(snapshot)
  }

  private async restartWatchers(): Promise<void> {
    this.closeWatchers()

    if (this.disposed) {
      return
    }

    const context = await resolveScanContext(this.settings)
    this.status.lastError = context.warning
    this.emitStatus()

    for (const rootPath of context.scanRoots) {
      try {
        const watcher = watch(rootPath, { recursive: true }, () => {
          this.scheduleDebouncedSync()
        })

        watcher.on('error', (error) => {
          this.status.lastError = `Watcher error (${rootPath}): ${formatError(error)}`
          this.emitStatus()
        })

        this.watchers.push(watcher)
      } catch (error) {
        this.status.lastError = `Watcher setup failed (${rootPath}): ${formatError(error)}`
        this.emitStatus()
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // Ignore watcher close errors.
      }
    }
    this.watchers = []
  }

  public async wantListAdd(input: WantListAddInput): Promise<WantListItem> {
    await this.ensureReady()
    return this.wantListStore.add(input)
  }

  public async wantListGet(id: number): Promise<WantListItem | null> {
    await this.ensureReady()
    return this.wantListStore.get(id)
  }

  public async wantListUpdate(id: number, input: WantListAddInput): Promise<WantListItem | null> {
    await this.ensureReady()
    return this.wantListStore.update(id, input)
  }

  public async wantListUpdatePipeline(id: number, patch: WantListPipelinePatch): Promise<WantListItem | null> {
    await this.ensureReady()
    return this.wantListStore.updatePipeline(id, patch)
  }

  public async wantListRemove(id: number): Promise<void> {
    await this.ensureReady()
    await this.wantListStore.remove(id)
  }

  public async removeWantListsForDownloadedFile(filenameInput: string): Promise<number[]> {
    await this.ensureReady()
    const filename = normalizeFilename(filenameInput)
    if (!filename) return []
    const result = await this.pool.query<{ id: number | bigint }>(
      `
        WITH linked AS (
          SELECT DISTINCT want_list_id AS id
          FROM download_attempts
          WHERE local_filename = $1 AND want_list_id IS NOT NULL
        ),
        cleared AS (
          UPDATE download_attempts
          SET want_list_id = NULL, updated_at = now()
          WHERE want_list_id IN (SELECT id FROM linked)
        ),
        deleted AS (
          DELETE FROM want_list WHERE id IN (SELECT id FROM linked) RETURNING id
        )
        SELECT id FROM deleted
      `,
      [filename]
    )
    return [...new Set(result.rows.map((row) => toNumber(row.id)).filter((id) => id > 0))]
  }

  public async wantListList(): Promise<WantListItem[]> {
    await this.ensureReady()
    return this.wantListStore.list()
  }

  public async wantListListDueForDownload(limit: number): Promise<WantListItem[]> {
    await this.ensureReady()
    return this.wantListStore.listDueForDownload(limit)
  }

  public async downloadAttemptCreate(input: DownloadAttemptCreateInput): Promise<DownloadAttempt> {
    await this.ensureReady()
    return this.downloadAttemptStore.create(input)
  }

  public expectedDownloadFilename(remoteFilename: string | null): string | null {
    return buildExpectedDownloadFilename(this.settings.downloadFolderPaths, remoteFilename)
  }

  public async downloadAttemptUpdate(id: number, patch: DownloadAttemptPatch): Promise<DownloadAttempt | null> {
    await this.ensureReady()
    return this.downloadAttemptStore.update(id, patch)
  }

  public async downloadAttemptListForWantList(wantListId: number): Promise<DownloadAttempt[]> {
    await this.ensureReady()
    return this.downloadAttemptStore.listByWantListId(wantListId)
  }

  public async downloadAttemptListActive(limit: number): Promise<DownloadAttempt[]> {
    await this.ensureReady()
    return this.downloadAttemptStore.listActive(limit)
  }

  public async wantListSelectDownload(wantListId: number, downloadId: number): Promise<WantListItem | null> {
    await this.ensureReady()
    const attempt = (await this.downloadAttemptStore.listByWantListId(wantListId)).find((item) => item.id === downloadId)
    return attempt ? this.wantListStore.updatePipeline(wantListId, { selectedDownloadId: downloadId }) : null
  }

  public async acquireProcessLease(input: ProcessLeaseInput): Promise<ProcessLease | null> {
    await this.ensureReady()
    return this.processLeaseStore.acquire(input)
  }

  public async touchProcessLease(role: string, ownerId: string, leaseMs: number): Promise<boolean> {
    await this.ensureReady()
    return this.processLeaseStore.touch(role, ownerId, leaseMs)
  }

  public async releaseProcessLease(role: string, ownerId: string): Promise<void> {
    await this.ensureReady()
    await this.processLeaseStore.release(role, ownerId)
  }

  public async withDownloaderLock<T>(work: () => Promise<T>): Promise<T | null> {
    await this.ensureReady()
    const client = await this.pool.connect()
    const lockId = 2026051201
    try {
      const locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockId])).rows[0]?.locked
      if (!locked) return null
      try {
        return await work()
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => undefined)
      }
    } finally {
      client.release()
    }
  }

  public async getItemById(id: number): Promise<CollectionItemDetails | null> {
    await this.ensureReady()
    const row = (await this.pool.query<{ filename: string }>(
      `SELECT filename FROM collection_files WHERE id = $1`,
      [id]
    )).rows[0]
    return row ? this.getItem(row.filename) : null
  }

  public async upgradeCaseAdd(input: UpgradeCaseCreateInput): Promise<UpgradeCase> {
    await this.ensureReady()
    return this.upgradeCaseStore.add(input)
  }

  public async upgradeCaseGet(id: number): Promise<UpgradeCase | null> {
    await this.ensureReady()
    return this.upgradeCaseStore.get(id)
  }

  public async upgradeCaseGetByCollectionFilename(collectionFilename: string): Promise<UpgradeCase | null> {
    await this.ensureReady()
    return this.upgradeCaseStore.getByCollectionFilename(collectionFilename)
  }

  public async upgradeCaseUpdate(id: number, patch: UpgradeCasePatch): Promise<UpgradeCase | null> {
    await this.ensureReady()
    return this.upgradeCaseStore.update(id, patch)
  }

  public async upgradeCaseList(): Promise<UpgradeCase[]> {
    await this.ensureReady()
    return this.upgradeCaseStore.list()
  }

  public async upgradeCaseCandidates(id: number): Promise<UpgradeCandidate[]> {
    await this.ensureReady()
    return this.upgradeCaseStore.getCandidates(id)
  }

  public async upgradeCaseLocalCandidates(id: number): Promise<UpgradeLocalCandidate[]> {
    await this.ensureReady()
    return this.upgradeCaseStore.getLocalCandidates(id)
  }
}

import { watch, type FSWatcher } from 'node:fs'
import { extname, join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import type { AppSettings } from './settings-store'
import type { TaggerService } from './tagger-service.ts'
import { AUDIO_ANALYSIS_VERSION, AUDIO_HASH_VERSION, IDENTIFY_VERSION, IMPORT_REVIEW_VERSION } from '../shared/analysis-version.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
import {
  escapeLikePattern,
  formatError,
  getDownloadFolderPrefixes,
  normalizeFilename,
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
import { WantListStore } from './want-list-store.ts'
import { UpgradeCaseStore, type UpgradeCaseCreateInput, type UpgradeCasePatch } from './upgrade-case-store.ts'
import {
  replaceAudioIdentificationCandidates as replaceAudioIdentificationCandidatesDb,
  syncFileIdentificationStateFromAudioState as syncFileIdentificationStateFromAudioStateDb,
  upsertAudioIdentificationState as upsertAudioIdentificationStateDb
} from './collection-service-audio-hash.ts'
import {
  findRecordingByAudioHash as findRecordingByAudioHashDb,
  findSourceClaimMatches as findSourceClaimMatchesDb,
  listRecordingsForMatching as listRecordingsForMatchingDb,
  materializeRecordingDurations as materializeRecordingDurationsDb
} from './collection-service-recordings.ts'
import type {
  AudioAnalysis,
  CollectionItemDetails,
  FileIdentificationState,
  IdentifyReviewData,
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
} from '../shared/api.ts'
import { compareQuality, fileQualityFromExt, qualityScore } from '../shared/quality.ts'
import type {
  IdentificationDecision,
  RecordingCandidateSuggestion,
  RecordingClaimInput,
  RecordingMatchRow,
  SourceClaimMatch
} from './recording-identity-service.ts'
import { buildCanonicalNormKey, parseImportReviewClaim } from './recording-identity-service.ts'

type CollectionServiceOptions = {
  connectionString: string
  taggerService?: TaggerService
  onUpdated?: (status: CollectionSyncStatus) => void
  onImportQueueChanged?: () => void
  onIdentificationQueueChanged?: () => void
  debounceMs?: number
  enableBackgroundSync?: boolean
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function parseAudioAnalysis(value: string | null | undefined): AudioAnalysis | null {
  if (!value) return null
  try {
    return JSON.parse(value) as AudioAnalysis
  } catch {
    return null
  }
}

function weightedAverage(values: Array<{ value: number | null; weight: number }>): number | null {
  let totalWeight = 0
  let total = 0
  for (const item of values) {
    if (item.value == null) continue
    total += item.value * item.weight
    totalWeight += item.weight
  }
  return totalWeight > 0 ? total / totalWeight : null
}

function formatStrength(format: string | null | undefined): number | null {
  if (!format) return null
  return (
    {
      wav: 1,
      aiff: 1,
      aif: 1,
      flac: 0.95,
      alac: 0.95,
      m4a: 0.65,
      aac: 0.65,
      ogg: 0.6,
      opus: 0.6,
      mp3: 0.45
    } as Record<string, number>
  )[format.toLowerCase()] ?? 0.5
}

function computeAnalysisQualityScore(analysis: AudioAnalysis | null): number | null {
  if (!analysis) return null
  const quality = weightedAverage([
    { value: formatStrength(analysis.format), weight: 0.28 },
    { value: analysis.bitrateKbps == null ? null : clamp01(analysis.bitrateKbps / 320), weight: 0.22 },
    { value: analysis.sampleRateHz == null ? null : clamp01(analysis.sampleRateHz / 48000), weight: 0.12 },
    { value: analysis.bitDepth == null ? formatStrength(analysis.format) : clamp01(analysis.bitDepth / 24), weight: 0.12 },
    { value: analysis.crestDb == null ? null : clamp01(analysis.crestDb / 16), weight: 0.14 },
    { value: analysis.airBandRmsDb == null ? null : clamp01((analysis.airBandRmsDb + 58) / 22), weight: 0.12 }
  ])
  const issues =
    weightedAverage([
      { value: analysis.noiseScore == null ? null : clamp01(analysis.noiseScore / 100), weight: 0.35 },
      { value: analysis.cutoffDb == null ? null : clamp01((analysis.cutoffDb - 6) / 18), weight: 0.25 },
      { value: analysis.rumbleScore == null ? null : clamp01(analysis.rumbleScore / 100), weight: 0.15 },
      { value: analysis.humScore == null ? null : clamp01(analysis.humScore / 100), weight: 0.1 },
      { value: analysis.vinylLikelihood == null ? null : clamp01(analysis.vinylLikelihood / 100), weight: 0.15 }
    ]) ?? 0
  if (quality == null) return null
  return Math.round(clamp01(quality * 0.72 + (1 - issues) * 0.28) * 100)
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

function candidateClaimText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function candidateClaimNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function claimFromCandidate(candidate: RecordingCandidateSuggestion): RecordingClaimInput | null {
  if ((candidate.provider !== 'discogs' && candidate.provider !== 'musicbrainz') || !candidate.payloadJson) return null
  try {
    const payload = JSON.parse(candidate.payloadJson) as Record<string, unknown>
    return {
      provider: candidate.provider,
      entityType: candidate.entityType,
      externalKey: candidate.externalKey,
      artist: candidateClaimText(payload.artist),
      title: candidateClaimText(payload.title),
      version: candidateClaimText(payload.version),
      releaseTitle: candidateClaimText(payload.releaseTitle),
      trackPosition: candidateClaimText(payload.trackPosition),
      year: candidateClaimText(payload.year),
      durationSeconds: candidateClaimNumber(payload.durationSeconds),
      confidence: candidate.score,
      rawJson: normalizeJsonText(candidate.payloadJson)
    }
  } catch {
    return null
  }
}

function parseIdentifyReviewData(value: unknown): IdentifyReviewData | null {
  return value && typeof value === 'object' ? (JSON.parse(JSON.stringify(value)) as IdentifyReviewData) : null
}

function withReviewCandidateIds(reviewData: IdentifyReviewData | null, candidateIds: Map<string, number>): IdentifyReviewData | null {
  return reviewData
    ? {
        ...reviewData,
        recordCandidates: reviewData.recordCandidates.map((candidate) => ({
          ...candidate,
          references: candidate.references.map((reference) => ({
            ...reference,
            candidateId: reference.assignable ? candidateIds.get(reference.externalKey) ?? reference.candidateId ?? null : null
          }))
        }))
      }
    : null
}

function withReviewRecordingLink(
  reviewData: IdentifyReviewData | null,
  key: string,
  recordingId: number
): IdentifyReviewData | null {
  return reviewData
    ? {
        ...reviewData,
        recordCandidates: reviewData.recordCandidates.map((candidate) =>
          candidate.key === key ? { ...candidate, recordingId } : candidate
        )
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
  artist: string
  title: string
  version: string | null
  length: string | null
  year: string | null
  album: string | null
  label: string | null
  addedAt: string
  pipelineStatus: string
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
}

export type WantListPipelinePatch = {
  pipelineStatus?: string
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

  private readonly upgradeCaseStore: UpgradeCaseStore

  private readonly onUpdated?: (status: CollectionSyncStatus) => void

  private readonly onImportQueueChanged?: () => void

  private readonly onIdentificationQueueChanged?: () => void

  private readonly debounceMs: number

  private readonly enableBackgroundSync: boolean

  private readonly ready: Promise<void>

  private readonly taggerService?: TaggerService

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
    this.upgradeCaseStore = new UpgradeCaseStore(this.pool)
    this.taggerService = options.taggerService
    this.onUpdated = options.onUpdated
    this.onImportQueueChanged = options.onImportQueueChanged
    this.onIdentificationQueueChanged = options.onIdentificationQueueChanged
    this.debounceMs = options.debounceMs ?? 750
    this.enableBackgroundSync = options.enableBackgroundSync ?? true
    this.ready = this.initializeSchema().then(async () => {
      this.status.itemCount = await this.readItemCount()
      await this.refreshImportQueueCounts()
      await this.refreshIdentificationQueueCounts()
    })
  }

  private async ensureReady(): Promise<void> {
    await this.ready
  }

  private readFileTags(filename: string): CollectionItemDetails['tags'] | null {
    if (!this.taggerService || !this.settings.musicFolderPath) return null
    const tags = this.taggerService.readTags(join(this.settings.musicFolderPath, filename))
    return tags
      ? {
          source: 'file_tags',
          artist: tags.artist || null,
          title: tags.title || null,
          version: null,
          album: tags.album,
          year: tags.year,
          comments: tags.comments,
          label: tags.label,
          catalogNumber: tags.catalogNumber,
          trackPosition: tags.trackPosition,
          discogsReleaseId: tags.discogsReleaseId,
          discogsTrackPosition: tags.discogsTrackPosition
        }
      : null
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
    if (this.enableBackgroundSync) await this.restartWatchers()
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
      identificationverifiedat: Date | string | null
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
        collection_files.id AS id,
        collection_files.filename AS filename,
        collection_files.filesize AS filesize,
        ${ftsQuery ? `ts_rank_cd(to_tsvector('simple', ${searchDocumentSql}), plainto_tsquery('simple', $1))` : 'NULL'} AS score,
        ${buildAnalysisJsonSql('collection_files.filename')} AS analysisJson,
        COALESCE(audio_hashes.recording_id, file_identification_state.recording_id) AS recordingId,
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
        COALESCE(audio_hashes.status, file_identification_state.status) AS identificationStatus,
        COALESCE(audio_hashes.confidence, file_identification_state.confidence) AS identificationConfidence,
        COALESCE(audio_hashes.assignment_method, file_identification_state.assignment_method) AS assignmentMethod,
        COALESCE(audio_hashes.verified_at, file_identification_state.verified_at) AS identificationVerifiedAt,
        recordings.canonical_artist AS recordingCanonicalArtist,
        recordings.canonical_title AS recordingCanonicalTitle,
        recordings.canonical_version AS recordingCanonicalVersion,
        recordings.canonical_year AS recordingCanonicalYear
      FROM collection_files
      LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
      LEFT JOIN audio_hashes ON audio_hashes.audio_hash = file_identification_state.audio_hash
      LEFT JOIN recordings ON recordings.id = COALESCE(audio_hashes.recording_id, file_identification_state.recording_id)
    `

    if (!ftsQuery) {
      const values = normalizedLimit ? [normalizedLimit] : []
      const limitSql = normalizedLimit ? 'LIMIT $1::int' : ''
      const result = await this.pool.query<ListRow>(selectSql + ` ORDER BY lower(collection_files.filename) ${limitSql}`, values)
      return toListResult(
        result.rows.map((row) => {
          const analysis = parseAudioAnalysis(row.analysisjson)
          return {
            id: toNumber(row.id),
            filename: row.filename,
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
            identificationVerifiedAt: toIso(row.identificationverifiedat),
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
          id: toNumber(row.id),
          filename: row.filename,
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
          identificationVerifiedAt: toIso(row.identificationverifiedat),
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
      identificationverifiedat: Date | string | null
      recordingcanonicalartist: string | null
      recordingcanonicaltitle: string | null
      recordingcanonicalversion: string | null
      recordingcanonicalyear: string | null
    }>(
      `
        SELECT
          collection_files.id,
          collection_files.filename,
          collection_files.filesize,
          collection_file_state.mtime_ms AS mtimeMs,
          COALESCE(audio_hashes.recording_id, file_identification_state.recording_id) AS recordingId,
          COALESCE(audio_hashes.status, file_identification_state.status) AS identificationStatus,
          COALESCE(audio_hashes.confidence, file_identification_state.confidence) AS identificationConfidence,
          COALESCE(audio_hashes.assignment_method, file_identification_state.assignment_method) AS assignmentMethod,
          COALESCE(audio_hashes.verified_at, file_identification_state.verified_at) AS identificationVerifiedAt,
          recordings.canonical_artist AS recordingCanonicalArtist,
          recordings.canonical_title AS recordingCanonicalTitle,
          recordings.canonical_version AS recordingCanonicalVersion,
          recordings.canonical_year AS recordingCanonicalYear
        FROM collection_files
        LEFT JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
        LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
        LEFT JOIN audio_hashes ON audio_hashes.audio_hash = file_identification_state.audio_hash
        LEFT JOIN recordings ON recordings.id = COALESCE(audio_hashes.recording_id, file_identification_state.recording_id)
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
        reviewdata: unknown | null
        verifiedat: Date | string | null
        processedat: Date | string | null
        errormessage: string | null
      }>(
        `
          SELECT
            COALESCE(audio_hashes.recording_id, file_identification_state.recording_id) AS recordingId,
            file_identification_state.audio_hash AS audioHash,
            COALESCE(audio_hashes.status, file_identification_state.status) AS status,
            COALESCE(audio_hashes.assignment_method, file_identification_state.assignment_method) AS assignmentMethod,
            COALESCE(audio_hashes.confidence, file_identification_state.confidence) AS confidence,
            parsed_artist AS parsedArtist,
            parsed_title AS parsedTitle,
            parsed_version AS parsedVersion,
            parsed_year AS parsedYear,
            tag_artist AS tagArtist,
            tag_title AS tagTitle,
            tag_version AS tagVersion,
            COALESCE(audio_hashes.chosen_claim_id, file_identification_state.chosen_claim_id) AS chosenClaimId,
            GREATEST(COALESCE(audio_hashes.identify_version, 0), file_identification_state.identify_version) AS identifyVersion,
            COALESCE(audio_hashes.explanation_json, file_identification_state.explanation_json) AS explanationJson,
            COALESCE(audio_hashes.review_data, file_identification_state.review_data) AS reviewData,
            COALESCE(audio_hashes.verified_at, file_identification_state.verified_at) AS verifiedAt,
            COALESCE(audio_hashes.processed_at, file_identification_state.processed_at) AS processedAt,
            COALESCE(audio_hashes.error_message, file_identification_state.error_message) AS errorMessage
          FROM file_identification_state
          LEFT JOIN audio_hashes ON audio_hashes.audio_hash = file_identification_state.audio_hash
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
                candidate.id,
                candidate.provider,
                candidate.entity_type AS entityType,
                candidate.external_key AS externalKey,
                candidate.proposed_recording_id AS proposedRecordingId,
                candidate.score,
                candidate.disposition,
                candidate.payload_json AS payloadJson,
                recordings.canonical_artist AS recordingCanonicalArtist,
                recordings.canonical_title AS recordingCanonicalTitle,
                recordings.canonical_version AS recordingCanonicalVersion,
                recordings.canonical_year AS recordingCanonicalYear
              FROM ${identificationRow.audiohash ? 'audio_identification_candidates' : 'file_identification_candidates'} candidate
              LEFT JOIN recordings ON recordings.id = candidate.proposed_recording_id
              WHERE ${identificationRow.audiohash ? 'candidate.audio_hash = $1' : 'candidate.filename = $1'}
              ORDER BY candidate.score DESC, candidate.id
            `,
            [identificationRow.audiohash ?? filename]
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
          reviewData: parseIdentifyReviewData(identificationRow.reviewdata),
          verifiedAt: toIso(identificationRow.verifiedat),
          processedAt: toIso(identificationRow.processedat),
          errorMessage: identificationRow.errormessage,
          recordingCanonical,
          candidates: identificationCandidates
        }
      : null

    return {
      id: toNumber(itemRow.id),
      filename: itemRow.filename,
      filesize: toNumber(itemRow.filesize),
      mtimeMs: itemRow.mtimems == null ? null : toNumber(itemRow.mtimems),
      isDownload: isDownloadRelativeFilename(itemRow.filename, this.settings.downloadFolderPaths),
      recordingId: itemRow.recordingid == null ? null : toNumber(itemRow.recordingid),
      identificationStatus: itemRow.identificationstatus ?? null,
      identificationConfidence: itemRow.identificationconfidence ?? null,
      assignmentMethod: itemRow.assignmentmethod ?? null,
      identificationVerifiedAt: toIso(itemRow.identificationverifiedat),
      recordingCanonical,
      tags:
        this.readFileTags(filename) ??
        (importRow
          ? {
              source: 'import_review_cache',
              artist: importRow.parsedartist ?? null,
              title: importRow.parsedtitle ?? null,
              version: importRow.parsedversion ?? null,
              album: null,
              year: importRow.parsedyear ?? null,
              comments: null,
              label: null,
              catalogNumber: null,
              trackPosition: null,
              discogsReleaseId: null,
              discogsTrackPosition: null
            }
          : null),
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
      parsedAudioAnalysis,
      identification,
      upgradeCase: await this.upgradeCaseGetByCollectionFilename(itemRow.filename)
    }
  }

  public async getItemById(id: number): Promise<CollectionItemDetails | null> {
    await this.ensureReady()
    const row = (await this.pool.query<{ filename: string }>('SELECT filename FROM collection_files WHERE id = $1', [id])).rows[0]
    return row ? this.getItem(row.filename) : null
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
        identificationverifiedat: Date | string | null
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
      }>(
        `
          SELECT
            collection_files.id AS id,
            collection_files.filename AS filename,
            collection_files.filesize AS filesize,
            ${scoreSql} AS score,
            COALESCE(audio_hashes.recording_id, file_identification_state.recording_id) AS recordingId,
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
            COALESCE(audio_hashes.status, file_identification_state.status) AS identificationStatus,
            COALESCE(audio_hashes.confidence, file_identification_state.confidence) AS identificationConfidence,
            COALESCE(audio_hashes.assignment_method, file_identification_state.assignment_method) AS assignmentMethod,
            COALESCE(audio_hashes.verified_at, file_identification_state.verified_at) AS identificationVerifiedAt,
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
            import_review_cache.review_json AS importReviewJson
          FROM collection_files
          LEFT JOIN file_identification_state ON file_identification_state.filename = collection_files.filename
          LEFT JOIN audio_hashes ON audio_hashes.audio_hash = file_identification_state.audio_hash
          LEFT JOIN recordings ON recordings.id = COALESCE(audio_hashes.recording_id, file_identification_state.recording_id)
          LEFT JOIN import_review_cache ON import_review_cache.filename = collection_files.filename
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
        const sourceFilesize = toNumber(row.filesize)
        const sourceAnalysis = await this.readCachedAudioAnalysisByFilename(row.filename)
        const sourceQuality = await this.readFileQuality(row.filename, sourceFilesize)
        const existingFilesize = candidate?.exactExistingFilename
          ? await this.readCollectionFilesize(candidate.exactExistingFilename)
          : null
        const existingAnalysis = candidate?.exactExistingFilename
          ? await this.readCachedAudioAnalysisByFilename(candidate.exactExistingFilename)
          : null
        const existingQuality = candidate?.exactExistingFilename
          ? await this.readFileQuality(candidate.exactExistingFilename, existingFilesize)
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
          recordingId: row.recordingid == null ? null : toNumber(row.recordingid),
          recordingDiscogsUrl: recordingSourceUrlFromExternalKey(row.recordingdiscogsexternalkey),
          recordingMusicBrainzUrl: recordingSourceUrlFromExternalKey(row.recordingmusicbrainzexternalkey),
          identificationStatus: row.identificationstatus ?? (row.recordingid != null ? 'ready' : row.importstatus === 'error' ? 'error' : 'pending'),
          identificationConfidence: row.identificationconfidence ?? null,
          assignmentMethod: row.assignmentmethod ?? null,
          identificationVerifiedAt: toIso(row.identificationverifiedat),
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
          importMatchArtist: candidate?.match.artist ?? null,
          importMatchTitle: candidate?.match.title ?? null,
          importMatchVersion: candidate?.match.version ?? null,
          importMatchYear: candidate?.match.year ?? null,
          importReleaseTitle: candidate?.match.releaseTitle ?? null,
          importTrackPosition: candidate?.match.trackPosition ?? null,
          importExactExistingFilename: candidate?.exactExistingFilename ?? null,
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
    if (this.disposed || !this.enableBackgroundSync) {
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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS collection_files (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE,
        filename TEXT PRIMARY KEY,
        filesize BIGINT NOT NULL
      );

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
        duration_seconds DOUBLE PRECISION,
        canonical_norm_key TEXT,
        confidence INTEGER NOT NULL DEFAULT 0,
        review_state TEXT NOT NULL DEFAULT 'auto',
        metadata_locked BOOLEAN NOT NULL DEFAULT FALSE,
        merged_into_recording_id BIGINT REFERENCES recordings(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS recordings_canonical_norm_key_idx
      ON recordings(canonical_norm_key);

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
        review_data JSONB,
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
        review_data JSONB,
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
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT,
        length TEXT,
        year TEXT,
        album TEXT,
        label TEXT,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        pipeline_status TEXT NOT NULL DEFAULT 'idle',
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
    `)

    await this.pool.query(`
      ALTER TABLE collection_files
      ADD COLUMN IF NOT EXISTS id BIGINT
    `)

    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'collection_files_id_seq') THEN
          CREATE SEQUENCE collection_files_id_seq OWNED BY collection_files.id;
        END IF;
      END
      $$;
      ALTER TABLE collection_files ALTER COLUMN id SET DEFAULT nextval('collection_files_id_seq');
      UPDATE collection_files SET id = nextval('collection_files_id_seq') WHERE id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS collection_files_id_idx ON collection_files(id);
    `)

    await this.pool.query(`
      ALTER TABLE file_identification_state
      ADD COLUMN IF NOT EXISTS review_data JSONB
    `)

    await this.pool.query(`
      ALTER TABLE file_identification_state
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ
    `)

    await this.pool.query(`
      UPDATE file_identification_state
      SET verified_at = COALESCE(verified_at, processed_at)
      WHERE assignment_method = 'manual' AND verified_at IS NULL
    `)

    await this.pool.query(`
      DELETE FROM recording_source_claims
      WHERE provider = 'manual'
        AND entity_type = 'file_parse'
        AND COALESCE(raw_json->>'source', '') = 'identify_search_override'
    `)

    await this.pool.query(`
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

    await this.pool.query(`
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

    await this.pool.query(`
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

    await this.pool.query(`
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

    await this.pool.query(`
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

    await this.pool.query(`
      ALTER TABLE recordings
      ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION
    `)

    await this.syncFileIdentificationStateFromAudioState()
    await this.materializeRecordingDurations()
  }

  private async syncFileIdentificationStateFromAudioState(client?: Pool | PoolClient, audioHash?: string, filenames?: string[]): Promise<void> {
    await syncFileIdentificationStateFromAudioStateDb(client ?? this.pool, audioHash, filenames)
  }

  private async upsertAudioIdentificationState(
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
    await upsertAudioIdentificationStateDb(client, audioHash, data)
  }

  private async replaceAudioIdentificationCandidates(client: PoolClient, audioHash: string, candidates: RecordingCandidateSuggestion[]): Promise<Map<string, number>> {
    return replaceAudioIdentificationCandidatesDb(client, audioHash, candidates)
  }

  private async materializeRecordingDurations(recordingIds?: number[], client?: Pool | PoolClient): Promise<void> {
    await materializeRecordingDurationsDb(recordingIds, client ?? this.pool)
  }

  private async runSyncPass(): Promise<string | null> {
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
    if (changed.size === 0 && removed.length === 0) {
      return
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

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

      await this.archiveIdentificationStateWithClient(client, removed)
      for (const filename of removed) {
        await client.query('DELETE FROM collection_files WHERE filename = $1', [filename])
      }

      const touchedImportQueue = await this.syncImportReviewCacheWithClient(client, changed, removed)
      const touchedIdentificationQueue = await this.syncIdentificationStateWithClient(client, changed, removed)
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

  private async archiveIdentificationStateWithClient(client: PoolClient, filenames: string[]): Promise<void> {
    if (filenames.length === 0) return
    await client.query(
      `
        INSERT INTO file_identification_archive(
          filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
          parsed_artist, parsed_title, parsed_version, parsed_year,
          tag_artist, tag_title, tag_version, chosen_claim_id,
          identify_version, explanation_json, review_data, verified_at, error_message, processed_at,
          candidates_json, archived_at
        )
        SELECT
          state.filename,
          state.filesize,
          state.mtime_ms,
          state.recording_id,
          state.audio_hash,
          state.status,
          state.assignment_method,
          state.confidence,
          state.parsed_artist,
          state.parsed_title,
          state.parsed_version,
          state.parsed_year,
          state.tag_artist,
          state.tag_title,
          state.tag_version,
          state.chosen_claim_id,
          state.identify_version,
          state.explanation_json,
          state.review_data,
          state.verified_at,
          state.error_message,
          state.processed_at,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'provider', candidate.provider,
                  'entityType', candidate.entity_type,
                  'externalKey', candidate.external_key,
                  'proposedRecordingId', candidate.proposed_recording_id,
                  'score', candidate.score,
                  'disposition', candidate.disposition,
                  'payloadJson', candidate.payload_json
                )
                ORDER BY candidate.score DESC, candidate.id
              )
              FROM file_identification_candidates candidate
              WHERE candidate.filename = state.filename
            ),
            '[]'::jsonb
          ),
          now()
        FROM file_identification_state state
        WHERE state.filename = ANY($1::text[])
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
          review_data = excluded.review_data,
          verified_at = excluded.verified_at,
          error_message = excluded.error_message,
          processed_at = excluded.processed_at,
          candidates_json = excluded.candidates_json,
          archived_at = excluded.archived_at
      `,
      [filenames]
    )
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
      durationSeconds: item.parsedAudioAnalysis?.durationSeconds ?? claim.durationSeconds ?? null,
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
      recordingCanonical: matchedSource?.canonical ?? canonical,
      reviewData: null
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
            parsed?.artist ?? null,
            parsed?.title ?? null,
            parsed?.version ?? null,
            parsed?.year ?? null,
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
    const audioHash = (
      await this.pool.query<{ audiohash: string | null }>(
        `SELECT audio_hash AS audioHash FROM file_identification_state WHERE filename = $1`,
        [filename]
      )
    ).rows[0]?.audiohash
    return new Set(
      (
        await this.pool.query<{ externalkey: string }>(
          `
            SELECT external_key AS externalKey
            FROM ${audioHash ? 'audio_identification_candidates' : 'file_identification_candidates'}
            WHERE ${audioHash ? 'audio_hash = $1' : 'filename = $1'} AND disposition = 'rejected'
          `,
          [audioHash ?? filename]
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
                canonical_artist, canonical_title, canonical_version, canonical_year, duration_seconds, canonical_norm_key,
                confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
              ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, FALSE, NULL, now())
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
      const materializedClaims = recordingId == null
        ? []
        : [
            ...data.acceptedClaims,
            ...data.candidates
              .filter((candidate) => candidate.proposedRecordingId === recordingId)
              .map(claimFromCandidate)
              .filter((claim): claim is RecordingClaimInput => Boolean(claim))
              .filter((claim) => !data.acceptedClaims.some((accepted) => accepted.externalKey === claim.externalKey))
          ]
      for (const claim of materializedClaims) {
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

      if (recordingId && data.audioHash) {
        await client.query(
          `
            INSERT INTO audio_hashes(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT(audio_hash) DO UPDATE SET
              recording_id = EXCLUDED.recording_id,
              duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_hashes.duration_seconds),
              assigned_by = EXCLUDED.assigned_by,
              confidence = EXCLUDED.confidence,
              updated_at = now()
          `,
          [data.audioHash, recordingId, data.durationSeconds ?? null, data.assignmentMethod ?? 'manual', data.confidence ?? 0]
        )
      }

      if (recordingId) await this.materializeRecordingDurations([recordingId], client)

      const candidateIds = data.audioHash
        ? await this.replaceAudioIdentificationCandidates(client, data.audioHash, data.candidates)
        : new Map<string, number>()
      if (!data.audioHash) {
        await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [filename])
        for (const candidate of data.candidates) {
          const row = (
            await client.query<{ id: number | bigint }>(
              `
                INSERT INTO file_identification_candidates(
                  filename, provider, entity_type, external_key, proposed_recording_id, score, disposition, payload_json, processed_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
                RETURNING id
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
          ).rows[0]
          if (row) candidateIds.set(candidate.externalKey, toNumber(row.id))
        }
      }
      const reviewData = withReviewCandidateIds(data.reviewData, candidateIds)
      if (data.audioHash) {
        await this.upsertAudioIdentificationState(client, data.audioHash, {
          recordingId,
          status: data.status,
          assignmentMethod: data.assignmentMethod,
          confidence: data.confidence,
          chosenClaimId: data.chosenClaimId ?? (data.chosenExternalKey ? (claimIds.get(data.chosenExternalKey) ?? null) : null),
          identifyVersion: IDENTIFY_VERSION,
          explanationJson: data.explanationJson,
          reviewData,
          verifiedAt: null,
          errorMessage: null
        })
      }

      await client.query(
        `
          INSERT INTO file_identification_state(
            filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            tag_artist, tag_title, tag_version, chosen_claim_id,
            identify_version, explanation_json, review_data, verified_at, error_message, processed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, NULL, NULL, now())
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
            review_data = excluded.review_data,
            verified_at = COALESCE(file_identification_state.verified_at, excluded.verified_at),
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
          normalizeJsonText(data.explanationJson),
          normalizeJsonText(reviewData ? JSON.stringify(reviewData) : null)
        ]
      )
      if (data.audioHash) await this.syncFileIdentificationStateFromAudioState(client, data.audioHash)
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
    const audioHash = await this.readStoredAudioHash(filename)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (audioHash) {
        await this.upsertAudioIdentificationState(client, audioHash, {
          recordingId: null,
          status: 'error',
          assignmentMethod: null,
          confidence: null,
          chosenClaimId: null,
          identifyVersion: IDENTIFY_VERSION,
          explanationJson: null,
          reviewData: null,
          verifiedAt: null,
          errorMessage: data.errorMessage
        })
      }
      await client.query(
        `
          INSERT INTO file_identification_state(
            filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            tag_artist, tag_title, tag_version, chosen_claim_id,
            identify_version, explanation_json, review_data, verified_at, error_message, processed_at
          ) VALUES ($1, $2, $3, NULL, $4, 'error', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $5, NULL, NULL, NULL, $6, now())
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            audio_hash = COALESCE(excluded.audio_hash, file_identification_state.audio_hash),
            status = 'error',
            assignment_method = NULL,
            confidence = NULL,
            chosen_claim_id = NULL,
            identify_version = excluded.identify_version,
            explanation_json = NULL,
            review_data = NULL,
            verified_at = file_identification_state.verified_at,
            error_message = excluded.error_message,
            processed_at = now()
        `,
        [filename, data.filesize, data.mtimeMs, audioHash, IDENTIFY_VERSION, data.errorMessage]
      )
      if (audioHash) await this.syncFileIdentificationStateFromAudioState(client, audioHash)
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

  public async findRecordingByAudioHash(audioHash: string): Promise<{ recordingId: number; canonical: RecordingCanonical | null } | null> {
    await this.ensureReady()
    return findRecordingByAudioHashDb(this.pool, audioHash)
  }

  public async findSourceClaimMatches(externalKeys: string[]): Promise<SourceClaimMatch[]> {
    await this.ensureReady()
    return findSourceClaimMatchesDb(this.pool, externalKeys)
  }

  public async listRecordingsForMatching(): Promise<RecordingMatchRow[]> {
    await this.ensureReady()
    return listRecordingsForMatchingDb(this.pool)
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
        durationseconds: number | null
        confidence: number
        reviewstate: RecordingSummary['reviewState']
        metadatalocked: boolean
        mergedintorecordingid: number | bigint | null
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
            recordings.duration_seconds AS durationSeconds,
            recordings.confidence,
            recordings.review_state AS reviewState,
            recordings.metadata_locked AS metadataLocked,
            recordings.merged_into_recording_id AS mergedIntoRecordingId,
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
      durationSeconds: row.durationseconds == null ? null : Number(row.durationseconds),
      confidence: row.confidence,
      reviewState: row.reviewstate,
      metadataLocked: row.metadatalocked,
      mergedIntoRecordingId: row.mergedintorecordingid == null ? null : toNumber(row.mergedintorecordingid),
      fileCount: toNumber(row.filecount),
      claimCount: toNumber(row.claimcount)
    }))
  }

  public async getRecording(recordingId: number): Promise<RecordingDetails | null> {
    await this.ensureReady()
    const summaryRow = (
      await this.pool.query<{
        id: number | bigint
        canonicalartist: string | null
        canonicaltitle: string | null
        canonicalversion: string | null
        canonicalyear: string | null
        durationseconds: number | null
        confidence: number
        reviewstate: RecordingSummary['reviewState']
        metadatalocked: boolean
        mergedintorecordingid: number | bigint | null
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
            recordings.duration_seconds AS durationSeconds,
            recordings.confidence,
            recordings.review_state AS reviewState,
            recordings.metadata_locked AS metadataLocked,
            recordings.merged_into_recording_id AS mergedIntoRecordingId,
            COUNT(DISTINCT file_identification_state.filename) AS fileCount,
            COUNT(DISTINCT recording_source_claims.id) AS claimCount
          FROM recordings
          LEFT JOIN file_identification_state ON file_identification_state.recording_id = recordings.id
          LEFT JOIN recording_source_claims ON recording_source_claims.recording_id = recordings.id
          WHERE recordings.id = $1
          GROUP BY recordings.id
        `,
        [recordingId]
      )
    ).rows[0]
    const summary = summaryRow
      ? {
          id: toNumber(summaryRow.id),
          canonical: toCanonical(summaryRow.canonicalartist, summaryRow.canonicaltitle, summaryRow.canonicalversion, summaryRow.canonicalyear) ?? {
            artist: null,
            title: null,
            version: null,
            year: null
          },
          durationSeconds: summaryRow.durationseconds == null ? null : Number(summaryRow.durationseconds),
          confidence: summaryRow.confidence,
          reviewState: summaryRow.reviewstate,
          metadataLocked: summaryRow.metadatalocked,
          mergedIntoRecordingId: summaryRow.mergedintorecordingid == null ? null : toNumber(summaryRow.mergedintorecordingid),
          fileCount: toNumber(summaryRow.filecount),
          claimCount: toNumber(summaryRow.claimcount)
        }
      : null
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
        id: number | bigint
        filename: string
        filesize: number
        analysisjson: string | null
        status: IdentificationStatus
        confidence: number | null
        assignmentmethod: IdentificationAssignmentMethod | null
        verifiedat: Date | string | null
      }>(
        `
          SELECT
            collection_files.id,
            file_identification_state.filename,
            collection_files.filesize,
            ${buildAnalysisJsonSql('file_identification_state.filename')} AS analysisJson,
            status,
            confidence,
            assignment_method AS assignmentMethod,
            verified_at AS verifiedAt
          FROM file_identification_state
          JOIN collection_files ON collection_files.filename = file_identification_state.filename
          WHERE recording_id = $1
          ORDER BY lower(file_identification_state.filename)
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
      files: files.rows.map((row) => {
        const analysis = parseAudioAnalysis(row.analysisjson)
        return {
          id: toNumber(row.id),
          filename: row.filename,
          isDownload: isDownloadRelativeFilename(row.filename, this.settings.downloadFolderPaths),
          filesize: row.filesize,
          duration: analysis?.durationSeconds ?? null,
          bitrateKbps: analysis?.bitrateKbps ?? null,
          qualityScore: computeAnalysisQualityScore(analysis),
          audioAnalysis: analysis,
          status: row.status,
          confidence: row.confidence,
          assignmentMethod: row.assignmentmethod,
          verifiedAt: toIso(row.verifiedat)
        }
      })
    }
  }

  public async reviewIdentification(
    filename: string,
    action: 'accept' | 'reject' | 'create_recording' | 'unverify',
    candidateId?: number | null
  ): Promise<FileIdentificationState | null> {
    await this.ensureReady()
    const item = await this.getItem(filename)
    const audioHash = item?.identification?.audioHash ?? item?.fileAudioState?.audioHash ?? null
    if (action === 'unverify') {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        if (audioHash) {
          await client.query(
            `
              UPDATE audio_hashes
              SET verified_at = NULL, updated_at = now()
              WHERE audio_hash = $1
            `,
            [audioHash]
          )
          await this.syncFileIdentificationStateFromAudioState(client, audioHash)
        } else {
          await client.query(
            `
              UPDATE file_identification_state
              SET verified_at = NULL, processed_at = now()
              WHERE filename = $1
            `,
            [filename]
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } else if (action === 'reject') {
      if (!candidateId || !item?.identification) return null
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        if (audioHash) {
          await client.query(
            `
              UPDATE audio_identification_candidates
              SET disposition = 'rejected', processed_at = now()
              WHERE audio_hash = $1 AND id = $2
            `,
            [audioHash, candidateId]
          )
          await this.upsertAudioIdentificationState(client, audioHash, {
            recordingId: null,
            status: 'needs_review',
            assignmentMethod: null,
            confidence: null,
            chosenClaimId: null,
            identifyVersion: item.identification.identifyVersion,
            explanationJson: item.identification.explanationJson,
            reviewData: item.identification.reviewData,
            verifiedAt: null,
            errorMessage: null
          })
          await this.syncFileIdentificationStateFromAudioState(client, audioHash)
        } else {
          await client.query(
            `
              UPDATE file_identification_candidates
              SET disposition = 'rejected', processed_at = now()
              WHERE filename = $1 AND id = $2
            `,
            [filename, candidateId]
          )
          await client.query(
            `
              UPDATE file_identification_state
              SET status = 'needs_review', assignment_method = NULL, confidence = NULL, recording_id = NULL, chosen_claim_id = NULL, verified_at = NULL, processed_at = now()
              WHERE filename = $1
            `,
            [filename]
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } else {
      if (!item?.identification) return null
      const selectedCandidate =
        action === 'accept' && candidateId
          ? item.identification.candidates.find((candidate) => candidate.id === candidateId) ?? null
          : null
      const payload = selectedCandidate?.payloadJson ? (JSON.parse(selectedCandidate.payloadJson) as RecordingClaimInput) : null
      const canonical =
        selectedCandidate?.recordingCanonical ??
        toCanonical(
          payload?.artist ?? item.identification.tagArtist ?? item.identification.parsedArtist,
          payload?.title ?? item.identification.tagTitle ?? item.identification.parsedTitle,
          payload?.version ?? item.identification.tagVersion ?? item.identification.parsedVersion,
          payload?.year ?? item.identification.parsedYear
        )
      let recordingId = selectedCandidate?.proposedRecordingId ?? null
      if (!recordingId && selectedCandidate?.externalKey) {
        recordingId = (await this.findSourceClaimMatches([selectedCandidate.externalKey]))[0]?.recordingId ?? null
      }
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        if (!recordingId) {
          if (!canonical) {
            await client.query('ROLLBACK')
            return await this.getItem(filename).then((next) => next?.identification ?? null)
          }
          const created = (
            await client.query<{ id: number | bigint }>(
              `
                INSERT INTO recordings(
                  canonical_artist, canonical_title, canonical_version, canonical_year, duration_seconds, canonical_norm_key,
                  confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, 100, 'confirmed', TRUE, NULL, now())
                RETURNING id
              `,
              [canonical.artist, canonical.title, canonical.version, canonical.year, payload?.durationSeconds ?? null, buildCanonicalNormKey(canonical)]
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
              INSERT INTO audio_hashes(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
              VALUES ($1, $2, $3, 'manual', 100, now())
              ON CONFLICT(audio_hash) DO UPDATE SET
                recording_id = EXCLUDED.recording_id,
                duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_hashes.duration_seconds),
                assigned_by = 'manual',
                confidence = 100,
                updated_at = now()
            `,
            [item.fileAudioState.audioHash, recordingId, item.parsedAudioAnalysis?.durationSeconds ?? null]
          )
        }
        if (selectedCandidate) {
          await client.query(
            `
              UPDATE ${audioHash ? 'audio_identification_candidates' : 'file_identification_candidates'}
              SET proposed_recording_id = COALESCE(proposed_recording_id, $3), processed_at = now()
              WHERE ${audioHash ? 'audio_hash = $1' : 'filename = $1'} AND id = $2
            `,
            [audioHash ?? filename, selectedCandidate.id, recordingId]
          )
        }
        await this.materializeRecordingDurations([recordingId], client)
        await client.query(
          `
            UPDATE ${audioHash ? 'audio_identification_candidates' : 'file_identification_candidates'}
            SET disposition = CASE WHEN id = $2 THEN 'accepted' ELSE disposition END, processed_at = now()
            WHERE ${audioHash ? 'audio_hash = $1' : 'filename = $1'}
          `,
          [audioHash ?? filename, candidateId ?? 0]
        )
        const reviewData =
          canonical && buildCanonicalNormKey(canonical)
            ? withReviewRecordingLink(item.identification.reviewData, buildCanonicalNormKey(canonical), recordingId)
            : item.identification.reviewData
        if (audioHash) {
          await this.upsertAudioIdentificationState(client, audioHash, {
            recordingId,
            status: 'ready',
            assignmentMethod: 'manual',
            confidence: 100,
            chosenClaimId: null,
            identifyVersion: item.identification.identifyVersion,
            explanationJson: item.identification.explanationJson,
            reviewData,
            verifiedAt: nowIso(),
            errorMessage: null
          })
          await this.syncFileIdentificationStateFromAudioState(client, audioHash)
        } else {
          await client.query(
            `
              UPDATE file_identification_state
              SET
                recording_id = $2,
                status = 'ready',
                assignment_method = 'manual',
                confidence = 100,
                chosen_claim_id = NULL,
                review_data = $3::jsonb,
                verified_at = now(),
                error_message = NULL,
                processed_at = now()
              WHERE filename = $1
            `,
            [filename, recordingId, normalizeJsonText(reviewData ? JSON.stringify(reviewData) : null)]
          )
        }
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
    const nextItem = await this.getItem(filename)
    return nextItem?.identification ?? null
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
                canonical_artist, canonical_title, canonical_version, canonical_year, duration_seconds, canonical_norm_key,
                confidence, review_state, metadata_locked, merged_into_recording_id, updated_at
              ) VALUES ($1, $2, $3, $4, NULL, $5, 100, 'confirmed', TRUE, NULL, now())
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
        const stateRow = (
          await client.query<{ audiohash: string | null; explanationjson: unknown | null; reviewdata: IdentifyReviewData | null }>(
            `
              SELECT
                audio_hash AS audioHash,
                explanation_json AS explanationJson,
                review_data AS reviewData
              FROM file_identification_state
              WHERE filename = $1
            `,
            [filename]
          )
        ).rows[0]
        const analysisRow = (
          await client.query<{ analysisjson: string | null }>(
            `
              SELECT ${buildAnalysisJsonSql('$1')} AS analysisJson
            `,
            [filename]
          )
        ).rows[0]
        const analysis = parseAudioAnalysis(analysisRow?.analysisjson)
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
        const audioHash = stateRow?.audiohash
        if (audioHash) {
          await client.query(
            `
              INSERT INTO audio_hashes(audio_hash, recording_id, duration_seconds, assigned_by, confidence, updated_at)
              VALUES ($1, $2, $3, 'manual', 100, now())
              ON CONFLICT(audio_hash) DO UPDATE SET
                recording_id = EXCLUDED.recording_id,
                duration_seconds = COALESCE(EXCLUDED.duration_seconds, audio_hashes.duration_seconds),
                assigned_by = 'manual',
                confidence = 100,
                updated_at = now()
            `,
            [
              audioHash,
              recordingId,
              analysis?.durationSeconds ?? null
            ]
          )
          await this.upsertAudioIdentificationState(client, audioHash, {
            recordingId,
            status: 'ready',
            assignmentMethod: 'manual',
            confidence: 100,
            chosenClaimId: null,
            identifyVersion: IDENTIFY_VERSION,
            explanationJson: stateRow?.explanationjson == null ? null : JSON.stringify(stateRow.explanationjson),
            reviewData: parseIdentifyReviewData(stateRow?.reviewdata),
            verifiedAt: nowIso(),
            errorMessage: null
          })
          await this.syncFileIdentificationStateFromAudioState(client, audioHash)
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

  public async updateRecording(
    recordingId: number,
    canonicalInput: Partial<RecordingCanonical> | null | undefined,
    sourceClaimId?: number | null
  ): Promise<RecordingDetails | null> {
    await this.ensureReady()
    let canonical = toCanonical(
      canonicalInput?.artist,
      canonicalInput?.title,
      canonicalInput?.version,
      canonicalInput?.year
    )
    if (sourceClaimId != null) {
      const claim = (
        await this.pool.query<{
          artist: string | null
          title: string | null
          version: string | null
          year: string | null
        }>(
          `
            SELECT artist, title, version, year
            FROM recording_source_claims
            WHERE id = $1 AND recording_id = $2
          `,
          [sourceClaimId, recordingId]
        )
      ).rows[0]
      canonical =
        toCanonical(claim?.artist, claim?.title, claim?.version, claim?.year) ??
        canonical
    }
    if (!canonical) return this.getRecording(recordingId)
    await this.pool.query(
      `
        UPDATE recordings
        SET
          canonical_artist = $2,
          canonical_title = $3,
          canonical_version = $4,
          canonical_year = $5,
          canonical_norm_key = $6,
          review_state = 'confirmed',
          metadata_locked = TRUE,
          updated_at = now()
        WHERE id = $1
      `,
      [recordingId, canonical.artist, canonical.title, canonical.version, canonical.year, buildCanonicalNormKey(canonical)]
    )
    return this.getRecording(recordingId)
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
      await client.query(`UPDATE audio_hashes SET recording_id = $2, updated_at = now(), processed_at = now() WHERE recording_id = $1`, [sourceRecordingId, targetRecordingId])
      await client.query(
        `
          UPDATE file_identification_state
          SET recording_id = $2, assignment_method = COALESCE(assignment_method, 'manual'), processed_at = now()
          WHERE recording_id = $1
        `,
        [sourceRecordingId, targetRecordingId]
      )
      await this.syncFileIdentificationStateFromAudioState(client)
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
    const parsed = parseImportFilename(filename)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
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
      await client.query(
        `
          INSERT INTO file_identification_state(
            filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            tag_artist, tag_title, tag_version, chosen_claim_id,
            identify_version, explanation_json, review_data, verified_at, error_message, processed_at
          ) VALUES ($1, $2, $3, NULL, $4, 'pending', NULL, NULL, $5, $6, $7, $8, NULL, NULL, NULL, NULL, $9, NULL, NULL, NULL, NULL, NULL)
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            audio_hash = excluded.audio_hash,
            parsed_artist = COALESCE(file_identification_state.parsed_artist, excluded.parsed_artist),
            parsed_title = COALESCE(file_identification_state.parsed_title, excluded.parsed_title),
            parsed_version = COALESCE(file_identification_state.parsed_version, excluded.parsed_version),
            parsed_year = COALESCE(file_identification_state.parsed_year, excluded.parsed_year),
            identify_version = GREATEST(file_identification_state.identify_version, excluded.identify_version)
        `,
        [
          filename,
          data.filesize,
          data.mtimeMs,
          data.audioHash,
          parsed?.artist ?? null,
          parsed?.title ?? null,
          parsed?.version ?? null,
          parsed?.year ?? null,
          IDENTIFY_VERSION
        ]
      )
      await this.syncFileIdentificationStateFromAudioState(client, data.audioHash, [filename])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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
          parsed?.artist ?? null,
          parsed?.title ?? null,
          parsed?.version ?? null,
          parsed?.year ?? null
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
      const parsed = parseImportFilename(filename)
      const existing = (
        await client.query<{
          filesize: number | bigint
          status: IdentificationStatus
          recordingid: number | bigint | null
          verifiedat: string | null
          processedat: string | null
          reviewdata: IdentifyReviewData | null
        }>(
          `
            SELECT
              filesize,
              status,
              recording_id AS recordingId,
              verified_at AS verifiedAt,
              processed_at AS processedAt,
              review_data AS reviewData
            FROM file_identification_state
            WHERE filename = $1
          `,
          [filename]
        )
      ).rows[0]
      if (
        existing &&
        toNumber(existing.filesize) === change.filesize &&
        (existing.recordingid != null ||
          existing.verifiedat != null ||
          existing.processedat != null ||
          existing.reviewdata != null ||
          existing.status === 'ready' ||
          existing.status === 'needs_review')
      ) {
        await client.query(
          `
            UPDATE file_identification_state
            SET
              filesize = $2,
              mtime_ms = $3,
              parsed_artist = $4,
              parsed_title = $5,
              parsed_version = $6,
              parsed_year = $7,
              identify_version = GREATEST(identify_version, $8)
            WHERE filename = $1
          `,
          [
            filename,
            change.filesize,
            change.mtimeMs,
            parsed?.artist ?? null,
            parsed?.title ?? null,
            parsed?.version ?? null,
            parsed?.year ?? null,
            IDENTIFY_VERSION
          ]
        )
        continue
      }
      const archived = (
        await client.query<{
          filesize: number | bigint
          recordingid: number | bigint | null
          audiohash: string | null
          status: IdentificationStatus
          assignmentmethod: IdentificationAssignmentMethod | null
          confidence: number | bigint | null
          parsedartist: string | null
          parsedtitle: string | null
          parsedversion: string | null
          parsedyear: string | null
          tagartist: string | null
          tagtitle: string | null
          tagversion: string | null
          chosenclaimid: number | bigint | null
          identifyversion: number | bigint
          explanationjson: unknown
          reviewdata: IdentifyReviewData | null
          verifiedat: string | null
          errormessage: string | null
          processedat: string | null
          candidatesjson: Array<{
            provider: IdentificationCandidate['provider']
            entityType: IdentificationCandidate['entityType']
            externalKey: string
            proposedRecordingId: number | null
            score: number
            disposition: IdentificationCandidate['disposition']
            payloadJson: string | null
          }> | null
        }>(
          `
            SELECT
              filesize,
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
              review_data AS reviewData,
              verified_at AS verifiedAt,
              error_message AS errorMessage,
              processed_at AS processedAt,
              candidates_json AS candidatesJson
            FROM file_identification_archive
            WHERE filename = $1
          `,
          [filename]
        )
      ).rows[0]
      if (
        archived &&
        toNumber(archived.filesize) === change.filesize &&
        (archived.recordingid != null ||
          archived.assignmentmethod != null ||
          archived.verifiedat != null ||
          archived.processedat != null ||
          archived.reviewdata != null ||
          archived.status === 'ready' ||
          archived.status === 'needs_review')
      ) {
        await client.query(
          `
            INSERT INTO file_identification_state(
              filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
              parsed_artist, parsed_title, parsed_version, parsed_year,
              tag_artist, tag_title, tag_version, chosen_claim_id,
              identify_version, explanation_json, review_data, verified_at, error_message, processed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
              review_data = excluded.review_data,
              verified_at = excluded.verified_at,
              error_message = excluded.error_message,
              processed_at = excluded.processed_at
          `,
          [
            filename,
            change.filesize,
            change.mtimeMs,
            archived.recordingid == null ? null : toNumber(archived.recordingid),
            archived.audiohash,
            archived.status,
            archived.assignmentmethod,
            archived.confidence == null ? null : toNumber(archived.confidence),
            archived.parsedartist ?? parsed?.artist ?? null,
            archived.parsedtitle ?? parsed?.title ?? null,
            archived.parsedversion ?? parsed?.version ?? null,
            archived.parsedyear ?? parsed?.year ?? null,
            archived.tagartist,
            archived.tagtitle,
            archived.tagversion,
            archived.chosenclaimid == null ? null : toNumber(archived.chosenclaimid),
            toNumber(archived.identifyversion),
            archived.explanationjson == null ? null : JSON.stringify(archived.explanationjson),
            archived.reviewdata == null ? null : JSON.stringify(archived.reviewdata),
            archived.verifiedat,
            archived.errormessage,
            archived.processedat
          ]
        )
        await client.query(`DELETE FROM file_identification_candidates WHERE filename = $1`, [filename])
        for (const candidate of archived.candidatesjson ?? []) {
          await client.query(
            `
              INSERT INTO file_identification_candidates(
                filename, provider, entity_type, external_key, proposed_recording_id, score, disposition, payload_json
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            `,
            [
              filename,
              candidate.provider,
              candidate.entityType,
              candidate.externalKey,
              candidate.proposedRecordingId,
              candidate.score,
              candidate.disposition,
              candidate.payloadJson
            ]
          )
        }
        if (archived.audiohash) {
          await this.upsertAudioIdentificationState(client, archived.audiohash, {
            recordingId: archived.recordingid == null ? null : toNumber(archived.recordingid),
            status: archived.status,
            assignmentMethod: archived.assignmentmethod,
            confidence: archived.confidence == null ? null : toNumber(archived.confidence),
            chosenClaimId: archived.chosenclaimid == null ? null : toNumber(archived.chosenclaimid),
            identifyVersion: toNumber(archived.identifyversion),
            explanationJson: archived.explanationjson == null ? null : JSON.stringify(archived.explanationjson),
            reviewData: archived.reviewdata,
            verifiedAt: archived.verifiedat,
            errorMessage: archived.errormessage
          })
          await this.replaceAudioIdentificationCandidates(
            client,
            archived.audiohash,
            (archived.candidatesjson ?? []).map((candidate) => ({
              provider: candidate.provider,
              entityType: candidate.entityType,
              externalKey: candidate.externalKey,
              proposedRecordingId: candidate.proposedRecordingId,
              score: candidate.score,
              disposition: candidate.disposition,
              payloadJson: candidate.payloadJson,
              recordingCanonical: null
            }))
          )
          await this.syncFileIdentificationStateFromAudioState(client, archived.audiohash, [filename])
        }
        continue
      }
      await client.query(
        `
          INSERT INTO file_identification_state(
            filename, filesize, mtime_ms, recording_id, audio_hash, status, assignment_method, confidence,
            parsed_artist, parsed_title, parsed_version, parsed_year,
            tag_artist, tag_title, tag_version, chosen_claim_id,
            identify_version, explanation_json, review_data, verified_at, error_message, processed_at
          ) VALUES ($1, $2, $3, NULL, NULL, 'pending', NULL, NULL, $4, $5, $6, $7, NULL, NULL, NULL, NULL, $8, NULL, NULL, NULL, NULL, NULL)
          ON CONFLICT(filename) DO UPDATE SET
            filesize = excluded.filesize,
            mtime_ms = excluded.mtime_ms,
            audio_hash = NULL,
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
            review_data = NULL,
            verified_at = NULL,
            error_message = NULL,
            processed_at = NULL
        `,
        [
          filename,
          change.filesize,
          change.mtimeMs,
          parsed?.artist ?? null,
          parsed?.title ?? null,
          parsed?.version ?? null,
          parsed?.year ?? null,
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

  public async wantListList(): Promise<WantListItem[]> {
    await this.ensureReady()
    return this.wantListStore.list()
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

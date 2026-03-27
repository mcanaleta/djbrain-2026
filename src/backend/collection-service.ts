import { watch, type FSWatcher } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AppSettings } from './settings-store'
import { AUDIO_ANALYSIS_VERSION, AUDIO_HASH_VERSION, IMPORT_REVIEW_VERSION } from '../shared/analysis-version.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
import {
  buildPrefixWhereClause,
  filterAndRankRows,
  formatError,
  getDownloadFolderPrefixes,
  normalizeFilename,
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

type CollectionServiceOptions = {
  databaseFilePath: string
  onUpdated?: (status: CollectionSyncStatus) => void
  onImportQueueChanged?: () => void
  debounceMs?: number
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

export type CollectionItem = {
  filename: string
  filesize: number
  score: number | null
  importStatus?: 'pending' | 'processing' | 'ready' | 'error' | null
  importArtist?: string | null
  importTitle?: string | null
  importVersion?: string | null
  importYear?: string | null
  importError?: string | null
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
  private readonly db: DatabaseSync

  private readonly wantListStore: WantListStore

  private readonly onUpdated?: (status: CollectionSyncStatus) => void

  private readonly onImportQueueChanged?: () => void

  private readonly debounceMs: number

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
    this.db = new DatabaseSync(options.databaseFilePath)
    this.wantListStore = new WantListStore(this.db)
    this.onUpdated = options.onUpdated
    this.onImportQueueChanged = options.onImportQueueChanged
    this.debounceMs = options.debounceMs ?? 750
    this.initializeSchema()
    this.status.itemCount = this.readItemCount()
    this.refreshImportQueueCounts()
  }

  public async reconfigure(settings: AppSettings): Promise<void> {
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
    await this.restartWatchers()
  }

  public getStatus(): CollectionSyncStatus {
    return { ...this.status }
  }

  public setQueueStatus(queueBackend: 'redis' | 'memory', queueDepth: number): void {
    this.status.queueBackend = queueBackend
    this.status.queueDepth = queueDepth
    this.emitStatus()
  }

  public list(query: string = ''): CollectionListResult {
    const rows = this.db
      .prepare(
        `
          SELECT filename, filesize
          FROM collection_files
          ORDER BY filename COLLATE NOCASE
        `
      )
      .all() as Array<{ filename: string; filesize: number | bigint }>

    return toListResult(filterAndRankRows(rows, query))
  }

  public listDownloads(query: string = ''): CollectionListResult {
    const prefixes = getDownloadFolderPrefixes(this.settings.downloadFolderPaths)
    if (prefixes.length === 0) {
      return {
        items: [],
        total: 0
      }
    }

    const { clause, params } = buildPrefixWhereClause('collection_files.filename', prefixes)
    const rows = this.db
      .prepare(
        `
          SELECT
            collection_files.filename AS filename,
            collection_files.filesize AS filesize,
            import_review_cache.status AS importStatus,
            import_review_cache.parsed_artist AS importArtist,
            import_review_cache.parsed_title AS importTitle,
            import_review_cache.parsed_version AS importVersion,
            import_review_cache.parsed_year AS importYear,
            import_review_cache.error_message AS importError
          FROM collection_files
          LEFT JOIN import_review_cache ON import_review_cache.filename = collection_files.filename
          WHERE ${clause}
          ORDER BY collection_files.filename COLLATE NOCASE
        `
      )
      .all(...params) as Array<{
        filename: string
        filesize: number | bigint
        importStatus?: CollectionItem['importStatus']
        importArtist?: string | null
        importTitle?: string | null
        importVersion?: string | null
        importYear?: string | null
        importError?: string | null
      }>

    return toListResult(filterAndRankRows(rows, query))
  }

  public async syncNow(): Promise<CollectionSyncStatus> {
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
          this.status.lastSyncedAt = new Date().toISOString()
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

    this.db.close()
  }

  private initializeSchema(): void {
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collection_files (
        filename TEXT PRIMARY KEY,
        filesize INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collection_file_state (
        filename TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS import_review_cache (
        filename TEXT PRIMARY KEY,
        filesize INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        review_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        parsed_artist TEXT,
        parsed_title TEXT,
        parsed_version TEXT,
        parsed_year TEXT,
        review_json TEXT,
        error_message TEXT,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS import_review_cache_status_idx
      ON import_review_cache(status, processed_at, filename);

      CREATE TABLE IF NOT EXISTS file_audio_state (
        filename TEXT PRIMARY KEY,
        filesize INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        hash_version INTEGER NOT NULL,
        audio_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS file_audio_state_status_idx
      ON file_audio_state(status, processed_at, filename);

      CREATE TABLE IF NOT EXISTS audio_analysis_cache (
        audio_hash TEXT NOT NULL,
        analysis_version INTEGER NOT NULL,
        analysis_json TEXT,
        error_message TEXT,
        processed_at TEXT,
        PRIMARY KEY(audio_hash, analysis_version)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS collection_files_fts USING fts5(
        filename,
        content='collection_files',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS collection_files_ai
      AFTER INSERT ON collection_files
      BEGIN
        INSERT INTO collection_files_fts(rowid, filename)
        VALUES (new.rowid, new.filename);
      END;

      CREATE TRIGGER IF NOT EXISTS collection_files_ad
      AFTER DELETE ON collection_files
      BEGIN
        INSERT INTO collection_files_fts(collection_files_fts, rowid, filename)
        VALUES ('delete', old.rowid, old.filename);
      END;

      CREATE TRIGGER IF NOT EXISTS collection_files_au
      AFTER UPDATE ON collection_files
      BEGIN
        INSERT INTO collection_files_fts(collection_files_fts, rowid, filename)
        VALUES ('delete', old.rowid, old.filename);
        INSERT INTO collection_files_fts(rowid, filename)
        VALUES (new.rowid, new.filename);
      END;
    `)
    const importReviewColumns = new Set(
      (this.db.prepare('PRAGMA table_info(import_review_cache)').all() as Array<{ name: string }>).map((r) => r.name)
    )
    if (!importReviewColumns.has('review_version')) {
      this.db.exec(`ALTER TABLE import_review_cache ADD COLUMN review_version INTEGER NOT NULL DEFAULT ${IMPORT_REVIEW_VERSION}`)
    }
    this.db.exec(`
      INSERT INTO collection_files_fts(collection_files_fts)
      VALUES ('rebuild');
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS want_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT,
        length TEXT,
        album TEXT,
        label TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    // Pipeline column migrations (idempotent)
    const existingColumns = new Set(
      (this.db.prepare('PRAGMA table_info(want_list)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    )
    const pipelineCols: Array<[string, string]> = [
      ['pipeline_status', "TEXT NOT NULL DEFAULT 'idle'"],
      ['search_id', 'TEXT'],
      ['search_result_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['best_candidates_json', 'TEXT'],
      ['download_username', 'TEXT'],
      ['download_filename', 'TEXT'],
      ['pipeline_error', 'TEXT'],
      ['discogs_release_id', 'INTEGER'],
      ['discogs_track_position', 'TEXT'],
      ['discogs_entity_type', 'TEXT'],
      ['year', 'TEXT'],
      ['imported_filename', 'TEXT']
    ]
    for (const [col, def] of pipelineCols) {
      if (!existingColumns.has(col)) {
        this.db.exec(`ALTER TABLE want_list ADD COLUMN ${col} ${def}`)
      }
    }
  }

  private async runSyncPass(): Promise<string | null> {
    const context = await resolveScanContext(this.settings)
    if (!context.musicRootPath || context.scanRoots.length === 0) {
      return context.warning
    }

    const knownState = this.readKnownState()
    const seen = new Set<string>()
    const changed = new Map<string, SyncChange>()
    let hadReadError = false

    if (context.musicRootPath && context.scanRoots.length > 0) {
      for (const rootPath of context.scanRoots) {
        hadReadError =
          (await scanDirectory(rootPath, context.musicRootPath, knownState, seen, changed)) ||
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

    this.applyChanges(changed, removed)
    this.status.itemCount = this.readItemCount()
    if (hadReadError) {
      return 'One or more scan folders could not be read. Existing collection entries were preserved.'
    }
    return context.warning
  }

  private readKnownState(): Map<string, number> {
    const rows = this.db
      .prepare(
        `
          SELECT filename, mtime_ms AS mtimeMs
          FROM collection_file_state
        `
      )
      .all() as Array<{ filename: string; mtimeMs: number | bigint }>

    const stateByFilename = new Map<string, number>()
    for (const row of rows) {
      stateByFilename.set(row.filename, toNumber(row.mtimeMs))
    }
    return stateByFilename
  }

  private applyChanges(changed: Map<string, SyncChange>, removed: string[]): void {
    if (changed.size === 0 && removed.length === 0) {
      return
    }

    const upsertFile = this.db.prepare(`
      INSERT INTO collection_files(filename, filesize)
      VALUES (?, ?)
      ON CONFLICT(filename) DO UPDATE SET
        filesize = excluded.filesize
    `)
    const upsertState = this.db.prepare(`
      INSERT INTO collection_file_state(filename, mtime_ms)
      VALUES (?, ?)
      ON CONFLICT(filename) DO UPDATE SET
        mtime_ms = excluded.mtime_ms
    `)
    const deleteFile = this.db.prepare('DELETE FROM collection_files WHERE filename = ?')
    const deleteState = this.db.prepare('DELETE FROM collection_file_state WHERE filename = ?')

    this.db.exec('BEGIN TRANSACTION;')
    try {
      for (const [filename, change] of changed.entries()) {
        upsertFile.run(filename, change.filesize)
        upsertState.run(filename, change.mtimeMs)
      }

      for (const filename of removed) {
        deleteFile.run(filename)
        deleteState.run(filename)
      }

      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }

    this.syncImportReviewCache(changed, removed)
    this.syncFileAnalysisState(changed, removed)
  }

  public queueImportReviewFiles(filenames: string[] = [], force: boolean = false): number {
    const uniqueFilenames = [...new Set(filenames.map(normalizeFilename).filter(Boolean))]
    const targetFilenames =
      uniqueFilenames.length > 0
        ? uniqueFilenames
        : this.listDownloads().items.map((item) => item.filename)
    if (targetFilenames.length === 0) return 0
    const selectState = this.db.prepare(`
      SELECT
        collection_files.filename AS filename,
        collection_files.filesize AS filesize,
        collection_file_state.mtime_ms AS mtimeMs,
        import_review_cache.status AS cacheStatus,
        import_review_cache.review_version AS cacheReviewVersion,
        import_review_cache.filesize AS cacheFilesize,
        import_review_cache.mtime_ms AS cacheMtimeMs
      FROM collection_files
      JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
      LEFT JOIN import_review_cache ON import_review_cache.filename = collection_files.filename
      WHERE collection_files.filename = ?
    `)
    const upsert = this.db.prepare(`
      INSERT INTO import_review_cache(
        filename, filesize, mtime_ms, review_version, status, parsed_artist, parsed_title, parsed_version, parsed_year, review_json, error_message, processed_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(filename) DO UPDATE SET
        filesize = excluded.filesize,
        mtime_ms = excluded.mtime_ms,
        review_version = excluded.review_version,
        status = CASE
          WHEN ? THEN 'pending'
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN 'ready'
          ELSE 'pending'
        END,
        parsed_artist = excluded.parsed_artist,
        parsed_title = excluded.parsed_title,
        parsed_version = excluded.parsed_version,
        parsed_year = excluded.parsed_year,
        review_json = CASE
          WHEN ? THEN NULL
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN import_review_cache.review_json
          ELSE NULL
        END,
        error_message = NULL,
        processed_at = CASE
          WHEN ? THEN NULL
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN import_review_cache.processed_at
          ELSE NULL
        END
    `)
    let queued = 0
    this.db.exec('BEGIN TRANSACTION;')
    try {
      for (const filename of targetFilenames) {
        if (!isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)) continue
        const row = selectState.get(filename) as
          | {
              filename: string
              filesize: number | bigint
              mtimeMs: number | bigint
              cacheStatus: string | null
              cacheReviewVersion: number | bigint | null
              cacheFilesize: number | bigint | null
              cacheMtimeMs: number | bigint | null
            }
          | undefined
        if (!row) continue
        const parsed = parseImportFilename(filename)
        const needsQueue =
          force ||
          row.cacheStatus !== 'ready' ||
          toNumber(row.cacheReviewVersion) !== IMPORT_REVIEW_VERSION ||
          toNumber(row.cacheFilesize) !== toNumber(row.filesize) ||
          toNumber(row.cacheMtimeMs) !== toNumber(row.mtimeMs)
        upsert.run(
          row.filename,
          toNumber(row.filesize),
          toNumber(row.mtimeMs),
          IMPORT_REVIEW_VERSION,
          parsed?.artist ?? null,
          parsed?.title ?? null,
          parsed?.version ?? null,
          parsed?.year ?? null,
          force ? 1 : 0,
          force ? 1 : 0,
          force ? 1 : 0
        )
        if (needsQueue) queued += 1
      }
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
    this.refreshImportQueueCounts()
    if (queued > 0) {
      this.emitStatus()
      this.onImportQueueChanged?.()
    }
    return queued
  }

  public resetImportReviewProcessing(): void {
    this.db.prepare(`UPDATE import_review_cache SET status = 'pending' WHERE status = 'processing'`).run()
    this.refreshImportQueueCounts()
    this.emitStatus()
  }

  public claimNextPendingImportReview():
    | { filename: string; filesize: number; mtimeMs: number; parsedArtist: string | null; parsedTitle: string | null; parsedVersion: string | null }
    | null {
    const row = this.db
      .prepare(
        `
          SELECT filename, filesize, mtime_ms AS mtimeMs, parsed_artist AS parsedArtist, parsed_title AS parsedTitle, parsed_version AS parsedVersion
          FROM import_review_cache
          WHERE status = 'pending'
          ORDER BY processed_at IS NOT NULL, processed_at, filename
          LIMIT 1
        `
      )
      .get() as
      | {
          filename: string
          filesize: number | bigint
          mtimeMs: number | bigint
          parsedArtist: string | null
          parsedTitle: string | null
          parsedVersion: string | null
        }
      | undefined
    if (!row) return null
    this.db.prepare(`UPDATE import_review_cache SET status = 'processing' WHERE filename = ?`).run(row.filename)
    this.refreshImportQueueCounts()
    this.emitStatus()
    return {
      filename: row.filename,
      filesize: toNumber(row.filesize),
      mtimeMs: toNumber(row.mtimeMs),
      parsedArtist: row.parsedArtist ?? null,
      parsedTitle: row.parsedTitle ?? null,
      parsedVersion: row.parsedVersion ?? null
    }
  }

  public readImportReviewCache(filename: string): string | null {
    const row = this.db
      .prepare(
        `
          SELECT import_review_cache.review_json AS reviewJson
          FROM import_review_cache
          JOIN collection_files ON collection_files.filename = import_review_cache.filename
          JOIN collection_file_state ON collection_file_state.filename = import_review_cache.filename
          WHERE import_review_cache.filename = ?
            AND import_review_cache.status = 'ready'
            AND import_review_cache.review_version = ?
            AND import_review_cache.mtime_ms = collection_file_state.mtime_ms
            AND import_review_cache.filesize = collection_files.filesize
        `
      )
      .get(filename, IMPORT_REVIEW_VERSION) as { reviewJson: string | null } | undefined
    return row?.reviewJson ?? null
  }

  public saveImportReviewCache(
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
  ): void {
    this.db.prepare(
      `
        INSERT INTO import_review_cache(
          filename, filesize, mtime_ms, review_version, status, parsed_artist, parsed_title, parsed_version, parsed_year, review_json, error_message, processed_at
        ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, NULL, datetime('now'))
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
          processed_at = datetime('now')
      `
    ).run(
      filename,
      data.filesize,
      data.mtimeMs,
      IMPORT_REVIEW_VERSION,
      data.parsedArtist,
      data.parsedTitle,
      data.parsedVersion,
      data.parsedYear,
      data.reviewJson
    )
    this.refreshImportQueueCounts()
    this.emitStatus()
  }

  public saveImportReviewError(
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
  ): void {
    this.db.prepare(
      `
        INSERT INTO import_review_cache(
          filename, filesize, mtime_ms, review_version, status, parsed_artist, parsed_title, parsed_version, parsed_year, review_json, error_message, processed_at
        ) VALUES (?, ?, ?, ?, 'error', ?, ?, ?, ?, NULL, ?, datetime('now'))
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
          processed_at = datetime('now')
      `
    ).run(
      filename,
      data.filesize,
      data.mtimeMs,
      IMPORT_REVIEW_VERSION,
      data.parsedArtist,
      data.parsedTitle,
      data.parsedVersion,
      data.parsedYear,
      data.errorMessage
    )
    this.refreshImportQueueCounts()
    this.emitStatus()
  }

  public listPendingImportReviewFilenames(): string[] {
    return (
      this.db
        .prepare(`SELECT filename FROM import_review_cache WHERE status = 'pending' ORDER BY processed_at IS NOT NULL, processed_at, filename`)
        .all() as Array<{ filename: string }>
    ).map((row) => row.filename)
  }

  public claimImportReviewFile(filename: string):
    | { filename: string; filesize: number; mtimeMs: number; parsedArtist: string | null; parsedTitle: string | null; parsedVersion: string | null }
    | null {
    const row = this.db
      .prepare(
        `
          UPDATE import_review_cache
          SET status = 'processing'
          WHERE filename = ? AND status = 'pending'
          RETURNING filename, filesize, mtime_ms AS mtimeMs, parsed_artist AS parsedArtist, parsed_title AS parsedTitle, parsed_version AS parsedVersion
        `
      )
      .get(filename) as
      | {
          filename: string
          filesize: number | bigint
          mtimeMs: number | bigint
          parsedArtist: string | null
          parsedTitle: string | null
          parsedVersion: string | null
        }
      | undefined
    if (!row) return null
    this.refreshImportQueueCounts()
    this.emitStatus()
    return {
      filename: row.filename,
      filesize: toNumber(row.filesize),
      mtimeMs: toNumber(row.mtimeMs),
      parsedArtist: row.parsedArtist ?? null,
      parsedTitle: row.parsedTitle ?? null,
      parsedVersion: row.parsedVersion ?? null
    }
  }

  public readFileSnapshot(filename: string): { filesize: number; mtimeMs: number } | null {
    const row = this.db
      .prepare(
        `
          SELECT collection_files.filesize AS filesize, collection_file_state.mtime_ms AS mtimeMs
          FROM collection_files
          JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
          WHERE collection_files.filename = ?
        `
      )
      .get(filename) as { filesize: number | bigint; mtimeMs: number | bigint } | undefined
    return row ? { filesize: toNumber(row.filesize), mtimeMs: toNumber(row.mtimeMs) } : null
  }

  public readStoredAudioHash(filename: string): string | null {
    const row = this.db
      .prepare(
        `
          SELECT file_audio_state.audio_hash AS audioHash
          FROM file_audio_state
          JOIN collection_files ON collection_files.filename = file_audio_state.filename
          JOIN collection_file_state ON collection_file_state.filename = file_audio_state.filename
          WHERE file_audio_state.filename = ?
            AND file_audio_state.status = 'ready'
            AND file_audio_state.hash_version = ?
            AND file_audio_state.mtime_ms = collection_file_state.mtime_ms
            AND file_audio_state.filesize = collection_files.filesize
        `
      )
      .get(filename, AUDIO_HASH_VERSION) as { audioHash: string | null } | undefined
    return row?.audioHash ?? null
  }

  public saveStoredAudioHash(filename: string, data: { filesize: number; mtimeMs: number; audioHash: string }): void {
    this.db.prepare(
      `
        INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
        VALUES (?, ?, ?, ?, ?, 'ready', NULL, datetime('now'))
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          hash_version = excluded.hash_version,
          audio_hash = excluded.audio_hash,
          status = 'ready',
          error_message = NULL,
          processed_at = datetime('now')
      `
    ).run(filename, data.filesize, data.mtimeMs, AUDIO_HASH_VERSION, data.audioHash)
  }

  public saveStoredAudioHashError(filename: string, data: { filesize: number; mtimeMs: number; errorMessage: string }): void {
    this.db.prepare(
      `
        INSERT INTO file_audio_state(filename, filesize, mtime_ms, hash_version, audio_hash, status, error_message, processed_at)
        VALUES (?, ?, ?, ?, NULL, 'error', ?, datetime('now'))
        ON CONFLICT(filename) DO UPDATE SET
          filesize = excluded.filesize,
          mtime_ms = excluded.mtime_ms,
          hash_version = excluded.hash_version,
          audio_hash = NULL,
          status = 'error',
          error_message = excluded.error_message,
          processed_at = datetime('now')
      `
    ).run(filename, data.filesize, data.mtimeMs, AUDIO_HASH_VERSION, data.errorMessage)
  }

  public readStoredAudioAnalysis(audioHash: string): string | null {
    const row = this.db
      .prepare(
        `
          SELECT analysis_json AS analysisJson
          FROM audio_analysis_cache
          WHERE audio_hash = ? AND analysis_version = ? AND analysis_json IS NOT NULL
        `
      )
      .get(audioHash, AUDIO_ANALYSIS_VERSION) as { analysisJson: string | null } | undefined
    return row?.analysisJson ?? null
  }

  public saveStoredAudioAnalysis(audioHash: string, analysisJson: string): void {
    this.db.prepare(
      `
        INSERT INTO audio_analysis_cache(audio_hash, analysis_version, analysis_json, error_message, processed_at)
        VALUES (?, ?, ?, NULL, datetime('now'))
        ON CONFLICT(audio_hash, analysis_version) DO UPDATE SET
          analysis_json = excluded.analysis_json,
          error_message = NULL,
          processed_at = datetime('now')
      `
    ).run(audioHash, AUDIO_ANALYSIS_VERSION, analysisJson)
  }

  private syncImportReviewCache(changed: Map<string, SyncChange>, removed: string[]): void {
    const changedDownloads = [...changed.entries()].filter(([filename]) =>
      isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)
    )
    const removedDownloads = removed.filter((filename) =>
      isDownloadRelativeFilename(filename, this.settings.downloadFolderPaths)
    )
    if (changedDownloads.length === 0 && removedDownloads.length === 0) return

    const upsert = this.db.prepare(`
      INSERT INTO import_review_cache(
        filename, filesize, mtime_ms, review_version, status, parsed_artist, parsed_title, parsed_version, parsed_year, review_json, error_message, processed_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(filename) DO UPDATE SET
        filesize = excluded.filesize,
        mtime_ms = excluded.mtime_ms,
        review_version = excluded.review_version,
        status = CASE
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN 'ready'
          ELSE 'pending'
        END,
        parsed_artist = excluded.parsed_artist,
        parsed_title = excluded.parsed_title,
        parsed_version = excluded.parsed_version,
        parsed_year = excluded.parsed_year,
        review_json = CASE
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN import_review_cache.review_json
          ELSE NULL
        END,
        error_message = CASE
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN import_review_cache.error_message
          ELSE NULL
        END,
        processed_at = CASE
          WHEN import_review_cache.mtime_ms = excluded.mtime_ms
           AND import_review_cache.filesize = excluded.filesize
           AND import_review_cache.review_version = excluded.review_version
           AND import_review_cache.status = 'ready'
          THEN import_review_cache.processed_at
          ELSE NULL
        END
    `)
    const remove = this.db.prepare(`DELETE FROM import_review_cache WHERE filename = ?`)
    this.db.exec('BEGIN TRANSACTION;')
    try {
      for (const [filename, change] of changedDownloads) {
        const parsed = parseImportFilename(filename)
        upsert.run(
          filename,
          change.filesize,
          change.mtimeMs,
          IMPORT_REVIEW_VERSION,
          parsed?.artist ?? null,
          parsed?.title ?? null,
          parsed?.version ?? null,
          parsed?.year ?? null
        )
      }
      for (const filename of removedDownloads) remove.run(filename)
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
    this.refreshImportQueueCounts()
    this.emitStatus()
    this.onImportQueueChanged?.()
  }

  private syncFileAnalysisState(changed: Map<string, SyncChange>, removed: string[]): void {
    const invalidate = this.db.prepare(`
      UPDATE file_audio_state
      SET filesize = ?, mtime_ms = ?, hash_version = ?, audio_hash = NULL, status = 'pending', error_message = NULL, processed_at = NULL
      WHERE filename = ?
    `)
    const remove = this.db.prepare(`DELETE FROM file_audio_state WHERE filename = ?`)
    this.db.exec('BEGIN TRANSACTION;')
    try {
      for (const [filename, change] of changed) invalidate.run(change.filesize, change.mtimeMs, AUDIO_HASH_VERSION, filename)
      for (const filename of removed) remove.run(filename)
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
  }

  private readItemCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM collection_files').get() as
      | { total: number | bigint }
      | undefined
    return row ? toNumber(row.total) : 0
  }

  private refreshImportQueueCounts(): void {
    const rows = this.db
      .prepare(
        `
          SELECT status, COUNT(*) AS total
          FROM import_review_cache
          GROUP BY status
        `
      )
      .all() as Array<{ status: string; total: number | bigint }>
    this.status.importPendingCount = 0
    this.status.importProcessingCount = 0
    this.status.importErrorCount = 0
    for (const row of rows) {
      if (row.status === 'pending') this.status.importPendingCount = toNumber(row.total)
      if (row.status === 'processing') this.status.importProcessingCount = toNumber(row.total)
      if (row.status === 'error') this.status.importErrorCount = toNumber(row.total)
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

  public wantListAdd(input: WantListAddInput): WantListItem {
    return this.wantListStore.add(input)
  }

  public wantListGet(id: number): WantListItem | null {
    return this.wantListStore.get(id)
  }

  public wantListUpdate(id: number, input: WantListAddInput): WantListItem | null {
    return this.wantListStore.update(id, input)
  }

  public wantListUpdatePipeline(id: number, patch: WantListPipelinePatch): WantListItem | null {
    return this.wantListStore.updatePipeline(id, patch)
  }

  public wantListRemove(id: number): void {
    this.wantListStore.remove(id)
  }

  public wantListList(): WantListItem[] {
    return this.wantListStore.list()
  }
}

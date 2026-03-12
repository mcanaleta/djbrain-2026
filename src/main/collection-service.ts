import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep, extname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AppSettings } from './settings-store'

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.aiff',
  '.aif',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.alac'
])

type ScanContext = {
  musicRootPath: string | null
  scanRoots: string[]
}

type SyncChange = {
  filesize: number
  mtimeMs: number
}

type CollectionServiceOptions = {
  databaseFilePath: string
  onUpdated?: (status: CollectionSyncStatus) => void
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
  serperApiKey: ''
}

export type CollectionItem = {
  filename: string
  filesize: number
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
}

export type WantListAddInput = {
  artist: string
  title: string
  version?: string | null
  length?: string | null
  album?: string | null
  label?: string | null
}

export type WantListPipelinePatch = {
  pipelineStatus?: string
  searchId?: string | null
  searchResultCount?: number
  bestCandidatesJson?: string | null
  downloadUsername?: string | null
  downloadFilename?: string | null
  pipelineError?: string | null
}

export type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected collection sync error'
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  return Number(value ?? 0)
}

function normalizeFilename(value: string): string {
  return value.replace(/[\\/]+/g, '/')
}

function normalizeRelativeFolderPath(value: string): string {
  return normalizeFilename(value).replace(/^\/+/, '').replace(/\/+$/, '')
}

function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && relativePath !== '..' && !isAbsolute(relativePath))
  )
}

export class CollectionService {
  private readonly db: DatabaseSync

  private readonly onUpdated?: (status: CollectionSyncStatus) => void

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
    lastError: null
  }

  constructor(options: CollectionServiceOptions) {
    this.db = new DatabaseSync(options.databaseFilePath)
    this.onUpdated = options.onUpdated
    this.debounceMs = options.debounceMs ?? 750
    this.initializeSchema()
    this.status.itemCount = this.readItemCount()
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
      serperApiKey: settings.serperApiKey
    }
    await this.restartWatchers()
  }

  public getStatus(): CollectionSyncStatus {
    return { ...this.status }
  }

  public list(query: string = ''): CollectionListResult {
    const ftsQuery = this.buildFtsQuery(query)
    if (ftsQuery) {
      const rows = this.db
        .prepare(
          `
            SELECT
              collection_files.filename AS filename,
              collection_files.filesize AS filesize
            FROM collection_files_fts
            JOIN collection_files ON collection_files.rowid = collection_files_fts.rowid
            WHERE collection_files_fts MATCH ?
            ORDER BY bm25(collection_files_fts), collection_files.filename COLLATE NOCASE
          `
        )
        .all(ftsQuery) as Array<{ filename: string; filesize: number | bigint }>
      return this.toListResult(rows)
    }

    const rows = this.db
      .prepare(
        `
          SELECT filename, filesize
          FROM collection_files
          ORDER BY filename COLLATE NOCASE
        `
      )
      .all() as Array<{ filename: string; filesize: number | bigint }>

    return this.toListResult(rows)
  }

  public listDownloads(query: string = ''): CollectionListResult {
    const prefixes = this.getDownloadFolderPrefixes()
    if (prefixes.length === 0) {
      return {
        items: [],
        total: 0
      }
    }

    const { clause, params } = this.buildPrefixWhereClause('collection_files.filename', prefixes)
    const ftsQuery = this.buildFtsQuery(query)

    if (ftsQuery) {
      const rows = this.db
        .prepare(
          `
            SELECT
              collection_files.filename AS filename,
              collection_files.filesize AS filesize
            FROM collection_files_fts
            JOIN collection_files ON collection_files.rowid = collection_files_fts.rowid
            WHERE collection_files_fts MATCH ? AND (${clause})
            ORDER BY bm25(collection_files_fts), collection_files.filename COLLATE NOCASE
          `
        )
        .all(ftsQuery, ...params) as Array<{ filename: string; filesize: number | bigint }>

      return this.toListResult(rows)
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            collection_files.filename AS filename,
            collection_files.filesize AS filesize
          FROM collection_files
          WHERE ${clause}
          ORDER BY collection_files.filename COLLATE NOCASE
        `
      )
      .all(...params) as Array<{ filename: string; filesize: number | bigint }>

    return this.toListResult(rows)
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
        await this.runSyncPass()
        this.status.lastError = null
        this.status.lastSyncedAt = new Date().toISOString()
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
      ['pipeline_error', 'TEXT']
    ]
    for (const [col, def] of pipelineCols) {
      if (!existingColumns.has(col)) {
        this.db.exec(`ALTER TABLE want_list ADD COLUMN ${col} ${def}`)
      }
    }
  }

  private async runSyncPass(): Promise<void> {
    const context = await this.resolveScanContext()
    const knownState = this.readKnownState()
    const seen = new Set<string>()
    const changed = new Map<string, SyncChange>()

    if (context.musicRootPath && context.scanRoots.length > 0) {
      for (const rootPath of context.scanRoots) {
        await this.scanDirectory(rootPath, context.musicRootPath, knownState, seen, changed)
      }
    }

    const removed: string[] = []
    for (const filename of knownState.keys()) {
      if (!seen.has(filename)) {
        removed.push(filename)
      }
    }

    this.applyChanges(changed, removed)
    this.status.itemCount = this.readItemCount()
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
  }

  private async scanDirectory(
    rootPath: string,
    musicRootPath: string,
    knownState: Map<string, number>,
    seen: Set<string>,
    changed: Map<string, SyncChange>
  ): Promise<void> {
    const pendingDirectories: string[] = [rootPath]

    while (pendingDirectories.length > 0) {
      const currentDirectory = pendingDirectories.pop()
      if (!currentDirectory) {
        continue
      }

      let entries: Dirent[]
      try {
        entries = await readdir(currentDirectory, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }

        const absolutePath = join(currentDirectory, entry.name)
        if (entry.isDirectory()) {
          pendingDirectories.push(absolutePath)
          continue
        }

        if (!entry.isFile() || !this.isSupportedAudioFile(entry.name)) {
          continue
        }

        const relativeFilename = this.toRelativeFilename(absolutePath, musicRootPath)
        if (!relativeFilename) {
          continue
        }

        seen.add(relativeFilename)

        let fileStats: Awaited<ReturnType<typeof stat>>
        try {
          fileStats = await stat(absolutePath)
        } catch {
          continue
        }

        const mtimeMs = Math.trunc(fileStats.mtimeMs)
        if (knownState.get(relativeFilename) === mtimeMs) {
          continue
        }

        changed.set(relativeFilename, {
          filesize: fileStats.size,
          mtimeMs
        })
      }
    }
  }

  private toRelativeFilename(absolutePath: string, musicRootPath: string): string | null {
    const relativePath = normalizeFilename(relative(musicRootPath, absolutePath))
    if (
      !relativePath ||
      relativePath === '.' ||
      relativePath === '..' ||
      relativePath.startsWith('../')
    ) {
      return null
    }
    return relativePath
  }

  private isSupportedAudioFile(fileName: string): boolean {
    return AUDIO_EXTENSIONS.has(extname(fileName).toLowerCase())
  }

  private getDownloadFolderPrefixes(): string[] {
    const seen = new Set<string>()
    const prefixes: string[] = []

    for (const rawPath of this.settings.downloadFolderPaths) {
      const normalizedPath = normalizeRelativeFolderPath(rawPath)
      if (!normalizedPath || normalizedPath === '.' || normalizedPath.startsWith('../')) {
        continue
      }
      if (seen.has(normalizedPath)) {
        continue
      }
      seen.add(normalizedPath)
      prefixes.push(normalizedPath)
    }

    prefixes.sort((left, right) => left.length - right.length)

    const deduped: string[] = []
    for (const prefix of prefixes) {
      if (
        deduped.some(
          (existingPrefix) => prefix === existingPrefix || prefix.startsWith(`${existingPrefix}/`)
        )
      ) {
        continue
      }
      deduped.push(prefix)
    }

    return deduped
  }

  private buildPrefixWhereClause(
    columnName: string,
    prefixes: string[]
  ): { clause: string; params: string[] } {
    const parts: string[] = []
    const params: string[] = []

    for (const prefix of prefixes) {
      parts.push(`(${columnName} = ? OR ${columnName} LIKE ? ESCAPE '\\')`)
      params.push(prefix, `${escapeLikePattern(prefix)}/%`)
    }

    return {
      clause: parts.join(' OR '),
      params
    }
  }

  private toListResult(
    rows: Array<{ filename: string; filesize: number | bigint }>
  ): CollectionListResult {
    const items = rows.map((row) => ({
      filename: row.filename,
      filesize: toNumber(row.filesize)
    }))

    return {
      items,
      total: items.length
    }
  }

  private buildFtsQuery(query: string): string | null {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    if (terms.length === 0) {
      return null
    }
    return terms.map((term) => `"${term}"*`).join(' AND ')
  }

  private readItemCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM collection_files').get() as
      | { total: number | bigint }
      | undefined
    return row ? toNumber(row.total) : 0
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

    const context = await this.resolveScanContext()
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

  private rowToWantListItem(row: Record<string, unknown>): WantListItem {
    return {
      id: toNumber(row['id']),
      artist: row['artist'] as string,
      title: row['title'] as string,
      version: (row['version'] as string | null) ?? null,
      length: (row['length'] as string | null) ?? null,
      album: (row['album'] as string | null) ?? null,
      label: (row['label'] as string | null) ?? null,
      addedAt: row['added_at'] as string,
      pipelineStatus: (row['pipeline_status'] as string | null) ?? 'idle',
      searchId: (row['search_id'] as string | null) ?? null,
      searchResultCount: toNumber(row['search_result_count'] ?? 0),
      bestCandidatesJson: (row['best_candidates_json'] as string | null) ?? null,
      downloadUsername: (row['download_username'] as string | null) ?? null,
      downloadFilename: (row['download_filename'] as string | null) ?? null,
      pipelineError: (row['pipeline_error'] as string | null) ?? null
    }
  }

  private readonly WANT_LIST_COLUMNS = `
    id, artist, title, version, length, album, label, added_at,
    pipeline_status, search_id, search_result_count, best_candidates_json,
    download_username, download_filename, pipeline_error
  `

  public wantListAdd(input: WantListAddInput): WantListItem {
    const row = this.db
      .prepare(
        `INSERT INTO want_list (artist, title, version, length, album, label)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING ${this.WANT_LIST_COLUMNS}`
      )
      .get(
        input.artist,
        input.title,
        input.version ?? null,
        input.length ?? null,
        input.album ?? null,
        input.label ?? null
      ) as Record<string, unknown>
    return this.rowToWantListItem(row)
  }

  public wantListGet(id: number): WantListItem | null {
    const row = this.db
      .prepare(`SELECT ${this.WANT_LIST_COLUMNS} FROM want_list WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToWantListItem(row) : null
  }

  public wantListUpdate(id: number, input: WantListAddInput): WantListItem | null {
    const row = this.db
      .prepare(
        `UPDATE want_list
         SET artist = ?, title = ?, version = ?, length = ?, album = ?, label = ?
         WHERE id = ?
         RETURNING ${this.WANT_LIST_COLUMNS}`
      )
      .get(
        input.artist,
        input.title,
        input.version ?? null,
        input.length ?? null,
        input.album ?? null,
        input.label ?? null,
        id
      ) as Record<string, unknown> | undefined
    return row ? this.rowToWantListItem(row) : null
  }

  public wantListUpdatePipeline(id: number, patch: WantListPipelinePatch): WantListItem | null {
    const parts: string[] = []
    const params: unknown[] = []
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
    if (parts.length === 0) return this.wantListGet(id)
    params.push(id)
    const row = this.db
      .prepare(
        `UPDATE want_list SET ${parts.join(', ')} WHERE id = ? RETURNING ${this.WANT_LIST_COLUMNS}`
      )
      .get(...params) as Record<string, unknown> | undefined
    return row ? this.rowToWantListItem(row) : null
  }

  public wantListRemove(id: number): void {
    this.db.prepare(`DELETE FROM want_list WHERE id = ?`).run(id)
  }

  public wantListList(): WantListItem[] {
    const rows = this.db
      .prepare(`SELECT ${this.WANT_LIST_COLUMNS} FROM want_list ORDER BY added_at DESC`)
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToWantListItem(row))
  }

  private async resolveScanContext(): Promise<ScanContext> {
    const musicFolderPath = this.settings.musicFolderPath.trim()
    if (!musicFolderPath) {
      return {
        musicRootPath: null,
        scanRoots: []
      }
    }

    const musicRootPath = resolve(musicFolderPath)

    try {
      const rootStats = await stat(musicRootPath)
      if (!rootStats.isDirectory()) {
        return {
          musicRootPath,
          scanRoots: []
        }
      }
    } catch {
      return {
        musicRootPath,
        scanRoots: []
      }
    }

    const candidates: string[] = []
    if (this.settings.songsFolderPath.trim()) {
      candidates.push(this.settings.songsFolderPath)
    }
    for (const relativePath of this.settings.downloadFolderPaths) {
      if (relativePath.trim()) {
        candidates.push(relativePath)
      }
    }

    const absoluteCandidates = Array.from(
      new Set(
        candidates
          .map((relativePath) => resolve(musicRootPath, relativePath))
          .filter((candidatePath) => isPathInside(musicRootPath, candidatePath))
      )
    )

    const existingRoots: string[] = []
    for (const candidatePath of absoluteCandidates) {
      try {
        const candidateStats = await stat(candidatePath)
        if (candidateStats.isDirectory()) {
          existingRoots.push(candidatePath)
        }
      } catch {
        // Ignore missing folders.
      }
    }

    existingRoots.sort((left, right) => left.length - right.length)

    const dedupedRoots: string[] = []
    for (const candidatePath of existingRoots) {
      if (
        dedupedRoots.some(
          (rootPath) => candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`)
        )
      ) {
        continue
      }
      dedupedRoots.push(candidatePath)
    }

    return {
      musicRootPath,
      scanRoots: dedupedRoots
    }
  }
}

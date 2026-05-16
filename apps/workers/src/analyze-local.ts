import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { AudioAnalysisService } from '@djbrain/backend/audio-analysis-service.ts'
import { CollectionService } from '@djbrain/backend/collection-service.ts'
import { FileAnalysisService } from '@djbrain/backend/file-analysis-service.ts'
import { LocalRecordingIdentityService } from '@djbrain/backend/local-recording-identity.ts'
import { buildLocalAnalysisTargets, buildSongsOnlySyncPlan, scanLocalSongFiles } from '@djbrain/backend/local-song-sync.ts'
import { ensureAppSchemaVersion } from '@djbrain/backend/runtime-governance.ts'
import { readSettings } from '@djbrain/backend/settings-store.ts'
import { TaggerService } from '@djbrain/backend/tagger-service.ts'
import { normalizeRelativeFolderPath } from '@djbrain/backend/collection-service-helpers.ts'
import { AUDIO_ANALYSIS_VERSION, AUDIO_HASH_VERSION, IDENTIFY_VERSION, LOCAL_TAG_VERSION } from '@djbrain/shared/analysis-version.ts'

type Options = {
  apply: boolean
  musicRoot: string
  songsFolder: string
  limit: number | null
  concurrency: number
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

function readOptions(): Options {
  const settings = readSettings()
  const musicRoot = readArg('--music-root') ?? settings.musicFolderPath
  if (!musicRoot.trim()) throw new Error('Set --music-root or DJBRAIN_MUSIC_FOLDER_PATH.')
  const limit = Number(readArg('--limit') ?? '')
  const concurrency = Number(readArg('--concurrency') ?? '1')
  const songsFolder = (readArg('--songs-folder') ?? settings.songsFolderPath) || 'songs'
  return {
    apply: process.argv.includes('--apply'),
    musicRoot: resolve(musicRoot),
    songsFolder: normalizeRelativeFolderPath(songsFolder),
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : null,
    concurrency: Math.max(1, Math.min(4, Number.isFinite(concurrency) ? Math.trunc(concurrency) : 1))
  }
}

function redactConnectionString(value: string): string {
  try {
    const url = new URL(value)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return value.replace(/:([^:@/]+)@/, ':***@')
  }
}

async function listKnownFileStateReadOnly(connectionString: string) {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    return (
      await pool.query<{ filename: string; filesize: number | bigint; mtimems: number | bigint }>(
        `
          SELECT collection_files.filename, collection_files.filesize, collection_file_state.mtime_ms AS mtimeMs
          FROM collection_files
          JOIN collection_file_state ON collection_file_state.filename = collection_files.filename
          ORDER BY collection_files.filename
        `
      )
    ).rows.map((row) => ({ filename: row.filename, filesize: Number(row.filesize), mtimeMs: Number(row.mtimems) }))
  } finally {
    await pool.end()
  }
}

async function assertCompatibleDatabase(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    await ensureAppSchemaVersion(pool, false)
  } finally {
    await pool.end()
  }
}

async function listCompleteLocalAnalysisReadOnly(connectionString: string): Promise<Set<string>> {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const rows = (await pool.query<{ filename: string }>(
      `
        SELECT collection_files.filename
        FROM collection_files
        JOIN collection_file_state cfs ON cfs.filename = collection_files.filename
        JOIN file_tag_state fts ON fts.filename = collection_files.filename
        JOIN file_identification_state fis ON fis.filename = collection_files.filename
        JOIN file_audio_state fas ON fas.filename = collection_files.filename
        JOIN audio_analysis_cache aac ON aac.audio_hash = fas.audio_hash
        WHERE fts.filesize = collection_files.filesize
          AND fts.mtime_ms = cfs.mtime_ms
          AND fts.tag_version = $1
          AND fis.filesize = collection_files.filesize
          AND fis.mtime_ms = cfs.mtime_ms
          AND fis.identify_version = $2
          AND fis.status = 'ready'
          AND fis.recording_id IS NOT NULL
          AND fas.filesize = collection_files.filesize
          AND fas.mtime_ms = cfs.mtime_ms
          AND fas.hash_version = $3
          AND fas.status = 'ready'
          AND fas.audio_hash IS NOT NULL
          AND aac.analysis_version = $4
          AND aac.analysis_json IS NOT NULL
      `,
      [LOCAL_TAG_VERSION, IDENTIFY_VERSION, AUDIO_HASH_VERSION, AUDIO_ANALYSIS_VERSION]
    )).rows
    return new Set(rows.map((row) => row.filename))
  } finally {
    await pool.end()
  }
}

async function listTerminalLocalAnalysisErrorsReadOnly(connectionString: string): Promise<Set<string>> {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const rows = (await pool.query<{ filename: string }>(
      `
        SELECT collection_files.filename
        FROM collection_files
        JOIN collection_file_state cfs ON cfs.filename = collection_files.filename
        JOIN file_tag_state fts ON fts.filename = collection_files.filename
        JOIN file_identification_state fis ON fis.filename = collection_files.filename
        JOIN file_audio_state fas ON fas.filename = collection_files.filename
        WHERE fts.filesize = collection_files.filesize
          AND fts.mtime_ms = cfs.mtime_ms
          AND fts.tag_version = $1
          AND fis.filesize = collection_files.filesize
          AND fis.mtime_ms = cfs.mtime_ms
          AND fis.identify_version = $2
          AND fis.status = 'ready'
          AND fis.recording_id IS NOT NULL
          AND fas.filesize = collection_files.filesize
          AND fas.mtime_ms = cfs.mtime_ms
          AND fas.hash_version = $3
          AND fas.status = 'error'
      `,
      [LOCAL_TAG_VERSION, IDENTIFY_VERSION, AUDIO_HASH_VERSION]
    )).rows
    return new Set(rows.map((row) => row.filename))
  } finally {
    await pool.end()
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${label} is not an accessible directory: ${path}`)
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<number> {
  let next = 0
  let errors = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++
        const item = items[index]
        if (!item) return
        try {
          await worker(item, index)
        } catch (error) {
          errors += 1
          console.error(`[error] ${error instanceof Error ? error.message : 'Unexpected local analysis error'}`)
        }
      }
    })
  )
  return errors
}

async function main(): Promise<void> {
  const dbUrl = process.env['DJBRAIN_POSTGRES_URL']?.trim() ?? ''
  if (!dbUrl) throw new Error('DJBRAIN_POSTGRES_URL is required.')
  await assertCompatibleDatabase(dbUrl)
  const options = readOptions()
  const songsRoot = join(options.musicRoot, options.songsFolder)
  await assertDirectory(options.musicRoot, 'Music root')
  await assertDirectory(songsRoot, 'Songs folder')
  const [known, completeFilenames, terminalErrorFilenames, scanned] = await Promise.all([
    listKnownFileStateReadOnly(dbUrl),
    listCompleteLocalAnalysisReadOnly(dbUrl),
    listTerminalLocalAnalysisErrorsReadOnly(dbUrl),
    scanLocalSongFiles(options.musicRoot, options.songsFolder)
  ])
  const plan = buildSongsOnlySyncPlan({ songsFolderPath: options.songsFolder, known, scanned })
  const knownSongCount = known.filter((item) => item.filename === options.songsFolder || item.filename.startsWith(`${options.songsFolder}/`)).length
  const deleteRatio = knownSongCount ? plan.deleted.length / knownSongCount : 0
  const forceFilenames = new Set([...plan.inserted, ...plan.updated].map((item) => item.filename))
  const allTargets = buildLocalAnalysisTargets({ scanned, completeFilenames, terminalErrorFilenames, forceFilenames, limit: null })
  const targets = buildLocalAnalysisTargets({ scanned, completeFilenames, terminalErrorFilenames, forceFilenames, limit: options.limit })

  console.log('Local-only collection analysis')
  console.log(`mode: ${options.apply ? 'apply' : 'dry-run'}`)
  console.log(`db: ${redactConnectionString(dbUrl)}`)
  console.log(`music root: ${options.musicRoot}`)
  console.log(`songs folder: ${options.songsFolder}`)
  console.log(`local songs: ${scanned.length}`)
  console.log(`db rows: ${known.length} (${knownSongCount} songs)`)
  console.log(`sync inserts: ${plan.inserted.length}`)
  console.log(`sync updates: ${plan.updated.length}`)
  console.log(`sync deletes: ${plan.deleted.length}`)
  console.log(`complete local analyses: ${completeFilenames.size}`)
  console.log(`terminal audio errors: ${terminalErrorFilenames.size}`)
  console.log(`analysis backlog: ${targets.length}${options.limit ? ` (limited from ${allTargets.length})` : ''}`)

  if (!options.apply) return
  if (scanned.length === 0) throw new Error('Refusing apply because the songs scan found zero files.')
  if (plan.deleted.length > 100 && deleteRatio > 0.25) {
    throw new Error(`Refusing apply because ${plan.deleted.length} deletes is ${Math.round(deleteRatio * 100)}% of known song rows.`)
  }

  const collectionService = new CollectionService({ connectionString: dbUrl })
  const fileAnalysisService = new FileAnalysisService({
    getCollectionService: () => collectionService,
    audioAnalysisService: new AudioAnalysisService()
  })
  const identityService = new LocalRecordingIdentityService({
    collectionService,
    fileAnalysisService,
    taggerService: new TaggerService(),
    resolveMusicRelativePath: (filename) => join(options.musicRoot, ...filename.split('/'))
  })
  const errors = await collectionService.applySongsOnlySyncPlan(plan)
    .then(() => runPool(targets, options.concurrency, async (filename, index) => {
      const result = await identityService.analyzeFile(filename.filename)
      console.log(`[${index + 1}/${targets.length}] ${result.status} ${result.assignmentMethod ?? 'none'} ${filename.filename}`)
    }))
    .finally(() => collectionService.dispose())
  console.log(`analysis complete: ${targets.length - errors} ok, ${errors} failed`)
  if (errors > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unexpected local analysis failure')
  process.exit(1)
})

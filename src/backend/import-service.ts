import { spawn } from 'node:child_process'
import { copyFile, mkdir, unlink, access, stat, readdir } from 'node:fs/promises'
import { join, extname, dirname, basename, resolve } from 'node:path'
import type { AppSettings } from './settings-store.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { DiscogsMatchService } from './discogs-match-service.ts'
import type { TaggerService } from './tagger-service.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
import {
  fileQualityFromExt,
  compareQuality,
  qualitySummary,
  type FileQuality
} from '../shared/quality.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImportResult =
  | { status: 'imported'; destRelativePath: string; match: DiscogsTrackMatch }
  | {
      status: 'imported_upgrade'
      destRelativePath: string
      match: DiscogsTrackMatch
      /** The existing (lower-quality) file that was kept alongside */
      existingRelativePath: string
    }
  | {
      status: 'skipped_existing'
      existingRelativePath: string
      match: DiscogsTrackMatch
      existingQuality: FileQuality
      newQuality: FileQuality
    }
  | { status: 'replaced'; replacedRelativePath: string; match: DiscogsTrackMatch }
  | { status: 'needs_review'; candidates: DiscogsTrackMatch[] }
  | { status: 'error'; message: string }

type ImportFileOptions = {
  conflictStrategy?: 'auto' | 'keep_both' | 'replace'
  replaceRelativePath?: string | null
}
type AudioConverter = (sourcePath: string, targetPath: string) => Promise<void>
type PreparedImportFile = { path: string; ext: string; bitrateHintKbps: number | null; converted: boolean }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFilenameSegment(s: string): string {
  return s
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildDestFilename(
  artist: string,
  title: string,
  version: string | null,
  ext: string
): string {
  const trackPart = version ? `${title} (${version})` : title
  const name = `${artist} - ${trackPart}`
  return sanitizeFilenameSegment(name) + ext
}

function importOutputExt(ext: string): string {
  return ext.toLowerCase() === '.mp3' ? ext : '.mp3'
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readQuality(filePath: string, bitrateHint: number | null = null): Promise<FileQuality> {
  const { size } = await stat(filePath)
  const ext = extname(filePath).toLowerCase()
  return fileQualityFromExt(ext, size, bitrateHint)
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function runFfmpegMp3(sourcePath: string, targetPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', '-nostdin', '-i', sourcePath, '-map', '0:a:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', '320k', targetPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.trim() || `ffmpeg mp3 conversion failed (${code ?? 'unknown'}).`))
    })
  })
}

/** Find a path like /dir/base (2).ext, (3).ext … that does not exist yet */
async function findAvailablePath(destAbsPath: string): Promise<string> {
  const dir = dirname(destAbsPath)
  const ext = extname(destAbsPath)
  const base = basename(destAbsPath, ext)
  let n = 2
  while (await fileExists(join(dir, `${base} (${n})${ext}`))) n++
  return join(dir, `${base} (${n})${ext}`)
}

async function findAvailableArchivePath(path: string): Promise<string> {
  const ext = extname(path)
  const stem = ext ? path.slice(0, -ext.length) : path
  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? path : `${stem} (${index + 1})${ext}`
    if (!(await fileExists(candidate))) return candidate
  }
}

function buildArchivePath(settings: AppSettings, sourceFilename: string): string {
  const normalized = sourceFilename.replace(/\\/g, '/').replace(/^\/+/, '')
  const songsPrefix = settings.songsFolderPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const suffix = normalized.startsWith(`${songsPrefix}/`) ? normalized.slice(songsPrefix.length + 1) : basename(normalized)
  return join(settings.musicFolderPath, '_replaced', new Date().toISOString().slice(0, 10), suffix)
}

function buildTags(match: DiscogsTrackMatch) {
  return {
    artist: match.artist,
    title: match.title,
    album: match.releaseTitle,
    year: match.year,
    label: match.label,
    catalogNumber: match.catalogNumber,
    trackPosition: match.trackPosition,
    discogsReleaseId: match.releaseId,
    discogsTrackPosition: match.trackPosition
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ImportService {
  private readonly discogsMatch: DiscogsMatchService
  private readonly tagger: TaggerService
  private readonly onlineSearch: OnlineSearchService
  private readonly audioConverter: AudioConverter

  constructor(discogsMatch: DiscogsMatchService, tagger: TaggerService, onlineSearch: OnlineSearchService, audioConverter: AudioConverter = runFfmpegMp3) {
    this.discogsMatch = discogsMatch
    this.tagger = tagger
    this.onlineSearch = onlineSearch
    this.audioConverter = audioConverter
  }

  /**
   * Full import pipeline for a single downloaded file.
   *
   * 1. Search Discogs and score the match.
   * 2. If confident: write tags, move to songs/<year>/<filename>.
   *    - If destination already exists:
   *      a. Compare quality (new vs existing).
   *      b. If new is better → import as "(2)" suffix (upgrade), keep both.
   *      c. If not better → skip (existing is as good or better).
   * 3. If not confident: return needs_review with ranked candidates.
   *
   * @param bitrateHintKbps  Optional bitrate from the download source (slskd).
   *                         Used to refine quality comparison for lossy files.
   */
  async importFile(
    settings: AppSettings,
    artist: string,
    title: string,
    version: string | null,
    localFilePath: string,
    bitrateHintKbps: number | null = null,
    options: ImportFileOptions = {}
  ): Promise<ImportResult> {
    if (!(await fileExists(localFilePath))) {
      return { status: 'error', message: `File not found: ${localFilePath}` }
    }

    console.log('[import] identifying:', artist, '-', title, version ?? '')

    const { match, candidates } = await this.discogsMatch.findTrack(
      settings,
      artist,
      title,
      version,
      this.onlineSearch
    )

    if (!match) {
      console.log('[import] no confident match, needs_review. candidates:', candidates.length)
      return { status: 'needs_review', candidates }
    }

    console.log(
      `[import] confident match: release=${match.releaseId} "${match.releaseTitle}" track="${match.title}" pos=${match.trackPosition} year=${match.year} score=${match.score}`
    )
    return this.importMatchedFile(settings, match, localFilePath, bitrateHintKbps, options)
  }

  /**
   * Import a file when the track metadata is already known (e.g. from the want list).
   * Skips Discogs lookup entirely and uses the provided match directly.
   */
  async importFileWithKnownMatch(
    settings: AppSettings,
    match: DiscogsTrackMatch,
    localFilePath: string,
    bitrateHintKbps: number | null = null,
    options: ImportFileOptions = {}
  ): Promise<ImportResult> {
    if (!(await fileExists(localFilePath))) {
      return { status: 'error', message: `File not found: ${localFilePath}` }
    }

    console.log('[import] importing with known match:', match.artist, '-', match.title, match.version ?? '')
    return this.importMatchedFile(settings, match, localFilePath, bitrateHintKbps, options)
  }

  /**
   * Try to find the local file for a completed slskd download.
   * Searches all configured download folders by the file's basename.
   */
  async resolveLocalPath(settings: AppSettings, slskdFilename: string): Promise<string | null> {
    // slskd paths use backslashes: @@xxx\Soulseek Downloads\complete\a\b\file.ext
    const parts = slskdFilename.replace(/\\/g, '/').split('/')
    const name = parts[parts.length - 1]
    if (!name) return null

    for (const folder of settings.downloadFolderPaths) {
      const absFolder = resolve(settings.musicFolderPath, folder)
      const found = await this.findByName(absFolder, name)
      if (found) return found
    }

    return null
  }

  private async findByName(dir: string, name: string): Promise<string | null> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await this.findByName(full, name)
        if (found) return found
      } else if (entry.isFile() && entry.name === name) {
        return full
      }
    }
    return null
  }

  private async importMatchedFile(
    settings: AppSettings,
    match: DiscogsTrackMatch,
    localFilePath: string,
    bitrateHintKbps: number | null = null,
    options: ImportFileOptions = {}
  ): Promise<ImportResult> {
    const year = match.year ?? 'unknown'
    const prepared = await this.prepareImportFile(localFilePath, bitrateHintKbps)
    const ext = prepared.ext
    const destFilename = buildDestFilename(match.artist, match.title, match.version, ext)
    const destDir = join(settings.musicFolderPath, settings.songsFolderPath, year)
    const destAbsPath = join(destDir, destFilename)
    const destRelativePath = join(settings.songsFolderPath, year, destFilename)
    const tags = buildTags(match)

    await mkdir(destDir, { recursive: true })

    if (options.conflictStrategy === 'replace') {
      const replaceRelativePath = options.replaceRelativePath || destRelativePath
      const replaceAbsPath = join(settings.musicFolderPath, replaceRelativePath)
      if (!(await fileExists(replaceAbsPath))) {
        await this.cleanupPreparedFile(prepared)
        return { status: 'error', message: `Replacement target not found: ${replaceRelativePath}` }
      }
      const replaceTags = this.tagger.readTags(replaceAbsPath) ?? tags
      await mkdir(dirname(replaceAbsPath), { recursive: true })
      await this.tagger.writeTags(prepared.path, replaceTags)
      const archivePath = await findAvailableArchivePath(buildArchivePath(settings, replaceRelativePath))
      await mkdir(dirname(archivePath), { recursive: true })
      await copyFile(replaceAbsPath, archivePath)
      await copyFile(prepared.path, replaceAbsPath)
      await unlink(localFilePath)
      await this.cleanupPreparedFile(prepared)
      return { status: 'replaced', replacedRelativePath: replaceRelativePath, match }
    }

    if (await fileExists(destAbsPath)) {
      if (options.conflictStrategy === 'keep_both') {
        const upgradePath = await findAvailablePath(destAbsPath)
        const upgradeRelativePath = join(settings.songsFolderPath, year, basename(upgradePath))
        await this.tagger.writeTags(prepared.path, tags)
        await copyFile(prepared.path, upgradePath)
        await unlink(localFilePath)
        await this.cleanupPreparedFile(prepared)
        return { status: 'imported_upgrade', destRelativePath: upgradeRelativePath, existingRelativePath: destRelativePath, match }
      }

      const newQuality = await readQuality(prepared.path, prepared.bitrateHintKbps)
      const existingQuality = await readQuality(destAbsPath)
      const comparison = compareQuality(newQuality, existingQuality)

      console.log(
        `[import] destination exists — new: ${qualitySummary(newQuality)}, existing: ${qualitySummary(existingQuality)} → ${comparison}`
      )

      if (comparison !== 'better') {
        await this.cleanupPreparedFile(prepared)
        return { status: 'skipped_existing', existingRelativePath: destRelativePath, match, existingQuality, newQuality }
      }

      const upgradePath = await findAvailablePath(destAbsPath)
      const upgradeRelativePath = join(settings.songsFolderPath, year, basename(upgradePath))
      console.log('[import] upgrading — saving new version as:', upgradeRelativePath)
      await this.tagger.writeTags(prepared.path, tags)
      await copyFile(prepared.path, upgradePath)
      await unlink(localFilePath)
      await this.cleanupPreparedFile(prepared)
      return { status: 'imported_upgrade', destRelativePath: upgradeRelativePath, existingRelativePath: destRelativePath, match }
    }

    await this.tagger.writeTags(prepared.path, tags)
    await copyFile(prepared.path, destAbsPath)
    await unlink(localFilePath)
    await this.cleanupPreparedFile(prepared)
    return { status: 'imported', destRelativePath, match }
  }

  private async prepareImportFile(localFilePath: string, bitrateHintKbps: number | null): Promise<PreparedImportFile> {
    const ext = extname(localFilePath).toLowerCase()
    if (ext === '.mp3') return { path: localFilePath, ext: importOutputExt(ext), bitrateHintKbps, converted: false }
    const targetPath = `${localFilePath}.tmp-${process.pid}-${Date.now()}.mp3`
    await this.audioConverter(localFilePath, targetPath)
    return { path: targetPath, ext: '.mp3', bitrateHintKbps: 320, converted: true }
  }

  private async cleanupPreparedFile(prepared: PreparedImportFile): Promise<void> {
    if (prepared.converted) await removeFileIfExists(prepared.path)
  }
}

// ─── Standalone helpers ───────────────────────────────────────────────────────

/**
 * Derive the basename expected in the download folder from a slskd filename.
 */
export function slskdBasename(slskdFilename: string): string {
  const parts = slskdFilename.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? slskdFilename
}

/**
 * Build the relative destination path for a track without going through Discogs
 * (e.g. when a user confirms a needs_review match manually).
 */
export function buildImportDestRelativePath(
  songsFolderPath: string,
  match: DiscogsTrackMatch,
  ext: string
): string {
  const year = match.year ?? 'unknown'
  const filename = buildDestFilename(match.artist, match.title, match.version, importOutputExt(ext))
  return join(songsFolderPath, year, filename)
}

/**
 * Parse a common "Artist - Title (Version) [Year].ext" filename into its parts.
 * Returns null if the pattern doesn't match.
 */
export function parseSongFilename(filename: string): {
  artist: string
  title: string
  version: string | null
} | null {
  const parsed = parseImportFilename(filename)
  return parsed ? { artist: parsed.artist, title: parsed.title, version: parsed.version } : null
}

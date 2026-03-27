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

/** Find a path like /dir/base (2).ext, (3).ext … that does not exist yet */
async function findAvailablePath(destAbsPath: string): Promise<string> {
  const dir = dirname(destAbsPath)
  const ext = extname(destAbsPath)
  const base = basename(destAbsPath, ext)
  let n = 2
  while (await fileExists(join(dir, `${base} (${n})${ext}`))) n++
  return join(dir, `${base} (${n})${ext}`)
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

  constructor(discogsMatch: DiscogsMatchService, tagger: TaggerService, onlineSearch: OnlineSearchService) {
    this.discogsMatch = discogsMatch
    this.tagger = tagger
    this.onlineSearch = onlineSearch
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
    const ext = extname(localFilePath).toLowerCase()
    const destFilename = buildDestFilename(match.artist, match.title, match.version, ext)
    const destDir = join(settings.musicFolderPath, settings.songsFolderPath, year)
    const destAbsPath = join(destDir, destFilename)
    const destRelativePath = join(settings.songsFolderPath, year, destFilename)
    const tags = buildTags(match)

    await mkdir(destDir, { recursive: true })

    if (options.conflictStrategy === 'replace') {
      const replaceRelativePath = options.replaceRelativePath || destRelativePath
      const replaceAbsPath = join(settings.musicFolderPath, replaceRelativePath)
      await mkdir(dirname(replaceAbsPath), { recursive: true })
      await this.tagger.writeTags(localFilePath, tags)
      await copyFile(localFilePath, replaceAbsPath)
      await unlink(localFilePath)
      return { status: 'replaced', replacedRelativePath: replaceRelativePath, match }
    }

    if (await fileExists(destAbsPath)) {
      if (options.conflictStrategy === 'keep_both') {
        const upgradePath = await findAvailablePath(destAbsPath)
        const upgradeRelativePath = join(settings.songsFolderPath, year, basename(upgradePath))
        await this.tagger.writeTags(localFilePath, tags)
        await copyFile(localFilePath, upgradePath)
        await unlink(localFilePath)
        return { status: 'imported_upgrade', destRelativePath: upgradeRelativePath, existingRelativePath: destRelativePath, match }
      }

      const newQuality = await readQuality(localFilePath, bitrateHintKbps)
      const existingQuality = await readQuality(destAbsPath)
      const comparison = compareQuality(newQuality, existingQuality)

      console.log(
        `[import] destination exists — new: ${qualitySummary(newQuality)}, existing: ${qualitySummary(existingQuality)} → ${comparison}`
      )

      if (comparison !== 'better') {
        return { status: 'skipped_existing', existingRelativePath: destRelativePath, match, existingQuality, newQuality }
      }

      const upgradePath = await findAvailablePath(destAbsPath)
      const upgradeRelativePath = join(settings.songsFolderPath, year, basename(upgradePath))
      console.log('[import] upgrading — saving new version as:', upgradeRelativePath)
      await this.tagger.writeTags(localFilePath, tags)
      await copyFile(localFilePath, upgradePath)
      await unlink(localFilePath)
      return { status: 'imported_upgrade', destRelativePath: upgradeRelativePath, existingRelativePath: destRelativePath, match }
    }

    await this.tagger.writeTags(localFilePath, tags)
    await copyFile(localFilePath, destAbsPath)
    await unlink(localFilePath)
    return { status: 'imported', destRelativePath, match }
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
  const filename = buildDestFilename(match.artist, match.title, match.version, ext)
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

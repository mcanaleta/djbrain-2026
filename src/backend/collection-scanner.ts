import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { access, readdir, rename, stat, unlink } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import NodeID3 from 'node-id3'
import type { AppSettings } from './settings-store'
import {
  formatError,
  getDownloadFolderPrefixes,
  isPathInside,
  isSupportedAudioFile,
  normalizeFilename
} from './collection-service-helpers.ts'

export type ScanContext = {
  downloadRootPaths: string[]
  musicRootPath: string | null
  scanRoots: string[]
  warning: string | null
}

export type SyncChange = {
  filesize: number
  mtimeMs: number
}

const execFileAsync = promisify(execFile)
const DOWNLOAD_WAV_STABLE_MS = 1000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isInsideDownloadRoots(absolutePath: string, downloadRootPaths: string[]): boolean {
  return downloadRootPaths.some((rootPath) => isPathInside(rootPath, absolutePath))
}

async function isStableFile(absolutePath: string, filesize: number, mtimeMs: number): Promise<boolean> {
  await wait(DOWNLOAD_WAV_STABLE_MS)
  try {
    const current = await stat(absolutePath)
    return current.size === filesize && Math.trunc(current.mtimeMs) === mtimeMs
  } catch {
    return false
  }
}

async function convertDownloadedWavToFlac(absolutePath: string): Promise<string | null> {
  const flacPath = absolutePath.replace(/\.wav$/i, '.flac')
  const tempPath = `${flacPath}.tmp-${process.pid}-${Date.now()}.flac`
  const rawTags = NodeID3.read(absolutePath)
  const userDefinedText =
    rawTags && !(rawTags instanceof Error)
      ? Array.isArray(rawTags.userDefinedText)
        ? rawTags.userDefinedText
        : rawTags.userDefinedText
          ? [rawTags.userDefinedText]
          : []
      : []
  const findUserValue = (description: string): string | null => {
    const match = userDefinedText.find((item) => {
      const current = typeof item === 'object' && item !== null && 'description' in item ? item.description : null
      return typeof current === 'string' && current.toUpperCase() === description
    })
    if (!match || typeof match !== 'object' || match === null || !('value' in match)) return null
    return typeof match.value === 'string' && match.value.trim() ? match.value.trim() : null
  }
  const metadataArgs = [
    ['artist', rawTags && !(rawTags instanceof Error) ? rawTags.artist : null],
    ['title', rawTags && !(rawTags instanceof Error) ? rawTags.title : null],
    ['album', rawTags && !(rawTags instanceof Error) ? rawTags.album : null],
    ['date', rawTags && !(rawTags instanceof Error) ? rawTags.year : null],
    ['publisher', rawTags && !(rawTags instanceof Error) ? rawTags.publisher : null],
    ['track', rawTags && !(rawTags instanceof Error) ? rawTags.trackNumber : null],
    ['DISCOGS_RELEASE_ID', findUserValue('DISCOGS_RELEASE_ID')],
    ['DISCOGS_TRACK_POSITION', findUserValue('DISCOGS_TRACK_POSITION')],
    ['DISCOGS_CATALOG_NUMBER', findUserValue('DISCOGS_CATALOG_NUMBER')]
  ].flatMap(([key, value]) =>
    typeof value === 'string' && value.trim() ? ['-metadata', `${key}=${value.trim()}`] : []
  )
  if (flacPath === absolutePath) return absolutePath
  try {
    await access(flacPath)
    console.warn(`[collection] skipping wav conversion because destination already exists: ${flacPath}`)
    return null
  } catch {
    // Destination does not exist yet.
  }
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-i',
        absolutePath,
        '-map',
        '0:a:0',
        '-map_metadata',
        '-1',
        ...metadataArgs,
        '-c:a',
        'flac',
        '-compression_level',
        '8',
        '-f',
        'flac',
        tempPath
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
    )
    await rename(tempPath, flacPath)
    await unlink(absolutePath)
    console.info(`[collection] converted download wav to flac: ${absolutePath} -> ${flacPath}`)
    return flacPath
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    console.warn(
      `[collection] wav conversion failed for ${absolutePath}: ${error instanceof Error ? error.message : 'Conversion failed.'}`
    )
    return null
  }
}

function toRelativeFilename(absolutePath: string, musicRootPath: string): string | null {
  const relativePath = normalizeFilename(relative(musicRootPath, absolutePath))
  if (!relativePath || relativePath === '.' || relativePath === '..' || relativePath.startsWith('../')) {
    return null
  }
  return relativePath
}

export function isDownloadRelativeFilename(filename: string, downloadFolderPaths: string[]): boolean {
  return getDownloadFolderPrefixes(downloadFolderPaths).some(
    (prefix) => filename === prefix || filename.startsWith(`${prefix}/`)
  )
}

export async function scanDirectory(
  rootPath: string,
  musicRootPath: string,
  knownState: Map<string, number>,
  seen: Set<string>,
  changed: Map<string, SyncChange>,
  downloadRootPaths: string[] = []
): Promise<boolean> {
  const pendingDirectories: string[] = [rootPath]
  let hadReadError = false

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()
    if (!currentDirectory) {
      continue
    }

    let entries: Dirent[]
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      hadReadError = true
      continue
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue
      }

      let absolutePath = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath)
        continue
      }
      if (!entry.isFile() || !isSupportedAudioFile(entry.name)) {
        continue
      }

      let fileStats: Awaited<ReturnType<typeof stat>>
      try {
        fileStats = await stat(absolutePath)
      } catch {
        continue
      }

      if (
        extname(absolutePath).toLowerCase() === '.wav' &&
        isInsideDownloadRoots(absolutePath, downloadRootPaths)
      ) {
        if (!(await isStableFile(absolutePath, fileStats.size, Math.trunc(fileStats.mtimeMs)))) {
          continue
        }
        const convertedPath = await convertDownloadedWavToFlac(absolutePath)
        if (!convertedPath) {
          continue
        }
        absolutePath = convertedPath
        try {
          fileStats = await stat(absolutePath)
        } catch {
          continue
        }
      }

      const relativeFilename = toRelativeFilename(absolutePath, musicRootPath)
      if (!relativeFilename) {
        continue
      }

      seen.add(relativeFilename)

      const mtimeMs = Math.trunc(fileStats.mtimeMs)
      if (knownState.get(relativeFilename) === mtimeMs) {
        continue
      }
      changed.set(relativeFilename, { filesize: fileStats.size, mtimeMs })
    }
  }

  return hadReadError
}

export async function resolveScanContext(settings: AppSettings): Promise<ScanContext> {
  const musicFolderPath = settings.musicFolderPath.trim()
  if (!musicFolderPath) {
    return {
      downloadRootPaths: [],
      musicRootPath: null,
      scanRoots: [],
      warning: 'Music root folder is not configured.'
    }
  }

  const musicRootPath = resolve(musicFolderPath)

  try {
    const rootStats = await stat(musicRootPath)
    if (!rootStats.isDirectory()) {
      return {
        downloadRootPaths: [],
        musicRootPath,
        scanRoots: [],
        warning: `Music root is not a directory: ${musicRootPath}`
      }
    }
  } catch (error) {
    return {
      downloadRootPaths: [],
      musicRootPath,
      scanRoots: [],
      warning: `Music root is not accessible: ${formatError(error)}`
    }
  }

  const candidates = [
    settings.songsFolderPath,
    ...settings.downloadFolderPaths.filter((relativePath) => relativePath.trim())
  ].filter(Boolean)

  const absoluteCandidates = Array.from(
    new Set(
      candidates
        .map((relativePath) => resolve(musicRootPath, relativePath))
        .filter((candidatePath) => isPathInside(musicRootPath, candidatePath))
    )
  )

  const absoluteDownloadRoots = Array.from(
    new Set(
      settings.downloadFolderPaths
        .filter((relativePath) => relativePath.trim())
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

  const downloadRootPaths: string[] = []
  for (const candidatePath of absoluteDownloadRoots) {
    try {
      const candidateStats = await stat(candidatePath)
      if (candidateStats.isDirectory()) {
        downloadRootPaths.push(candidatePath)
      }
    } catch {
      // Ignore missing folders.
    }
  }

  existingRoots.sort((left, right) => left.length - right.length)
  const scanRoots = existingRoots.filter(
    (candidatePath, index) =>
      !existingRoots
        .slice(0, index)
        .some((rootPath) => candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`))
  )

  return {
    downloadRootPaths,
    musicRootPath,
    scanRoots,
    warning:
      scanRoots.length > 0
        ? null
        : 'No accessible songs or download folders were found under the configured music root.'
  }
}

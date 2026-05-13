import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { AppSettings } from './settings-store'
import {
  formatError,
  getDownloadFolderPrefixes,
  isPathInside,
  isSupportedAudioFile,
  normalizeFilename
} from './collection-service-helpers.ts'

export type ScanContext = {
  musicRootPath: string | null
  scanRoots: string[]
  warning: string | null
}

export type SyncChange = {
  filesize: number
  mtimeMs: number
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
  changed: Map<string, SyncChange>
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

      const absolutePath = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath)
        continue
      }
      if (!entry.isFile() || !isSupportedAudioFile(entry.name)) {
        continue
      }

      const relativeFilename = toRelativeFilename(absolutePath, musicRootPath)
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
      changed.set(relativeFilename, { filesize: fileStats.size, mtimeMs })
    }
  }

  return hadReadError
}

export async function resolveScanContext(settings: AppSettings): Promise<ScanContext> {
  const musicFolderPath = settings.musicFolderPath.trim()
  if (!musicFolderPath) {
    return {
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
        musicRootPath,
        scanRoots: [],
        warning: `Music root is not a directory: ${musicRootPath}`
      }
    }
  } catch (error) {
    return {
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
  const scanRoots = existingRoots.filter(
    (candidatePath, index) =>
      !existingRoots
        .slice(0, index)
        .some((rootPath) => candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`))
  )

  return {
    musicRootPath,
    scanRoots,
    warning:
      scanRoots.length > 0
        ? null
        : 'No accessible songs or download folders were found under the configured music root.'
  }
}

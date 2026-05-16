import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { isPathInside, isSupportedAudioFile, normalizeFilename, normalizeRelativeFolderPath } from './collection-service-helpers.ts'

export type LocalSongFileState = {
  filename: string
  filesize: number
  mtimeMs: number
}

export type SongsOnlySyncPlan = {
  inserted: LocalSongFileState[]
  updated: LocalSongFileState[]
  deleted: string[]
  unchanged: number
}

function isInFolder(filename: string, folderPath: string): boolean {
  return filename === folderPath || filename.startsWith(`${folderPath}/`)
}

export function buildSongsOnlySyncPlan(input: {
  songsFolderPath: string
  known: LocalSongFileState[]
  scanned: LocalSongFileState[]
}): SongsOnlySyncPlan {
  const songsFolderPath = normalizeRelativeFolderPath(input.songsFolderPath || 'songs')
  const scanned = input.scanned.map((item) => ({ ...item, filename: normalizeFilename(item.filename) }))
  const scannedByFilename = new Map(scanned.map((item) => [item.filename, item]))
  const knownSongs = input.known
    .map((item) => ({ ...item, filename: normalizeFilename(item.filename) }))
    .filter((item) => isInFolder(item.filename, songsFolderPath))
  const knownByFilename = new Map(knownSongs.map((item) => [item.filename, item]))
  const inserted = scanned.filter((item) => !knownByFilename.has(item.filename))
  const updated = scanned.filter((item) => {
    const known = knownByFilename.get(item.filename)
    return known ? known.filesize !== item.filesize || known.mtimeMs !== item.mtimeMs : false
  })
  const deleted = knownSongs.map((item) => item.filename).filter((filename) => !scannedByFilename.has(filename)).sort()
  const unchanged = scanned.length - inserted.length - updated.length
  return { inserted, updated, deleted, unchanged }
}

export function buildLocalAnalysisTargets(input: {
  scanned: LocalSongFileState[]
  completeFilenames: Set<string>
  terminalErrorFilenames?: Set<string>
  forceFilenames: Set<string>
  limit: number | null
}): LocalSongFileState[] {
  const targets = input.scanned.filter((item) => {
    const filename = normalizeFilename(item.filename)
    return input.forceFilenames.has(filename) || (!input.completeFilenames.has(filename) && !input.terminalErrorFilenames?.has(filename))
  })
  return input.limit ? targets.slice(0, input.limit) : targets
}

export async function scanLocalSongFiles(musicRootPath: string, songsFolderPath: string): Promise<LocalSongFileState[]> {
  const musicRoot = resolve(musicRootPath)
  const songsRoot = resolve(musicRoot, normalizeRelativeFolderPath(songsFolderPath || 'songs'))
  if (!isPathInside(musicRoot, songsRoot)) throw new Error(`Songs folder is outside music root: ${songsRoot}`)
  const pending = [songsRoot]
  const files: LocalSongFileState[] = []
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const absolutePath = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (!entry.isFile() || !isSupportedAudioFile(entry.name)) continue
      const fileStats = await stat(absolutePath)
      files.push({
        filename: normalizeFilename(relative(musicRoot, absolutePath)),
        filesize: fileStats.size,
        mtimeMs: Math.trunc(fileStats.mtimeMs)
      })
    }
  }
  return files.sort((left, right) => left.filename.localeCompare(right.filename))
}

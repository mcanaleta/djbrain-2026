import { basename, join } from 'node:path'

export function buildReplacementArchiveRelativePath(songsFolderPath: string, sourceFilename: string, date: string): string {
  const normalized = sourceFilename.replace(/\\/g, '/').replace(/^\/+/, '')
  const songsPrefix = songsFolderPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const archiveSuffix = normalized.startsWith(`${songsPrefix}/`) ? normalized.slice(songsPrefix.length + 1) : basename(normalized)
  return join('_replaced', date, archiveSuffix)
}

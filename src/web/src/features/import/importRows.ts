import type { CollectionItem } from '../../../../shared/api'
import { deriveTrackSummaryFromFilename } from '../../lib/music-file'

export type ImportRow = CollectionItem & {
  artist: string
  title: string
  year: string
  prep: string
}

export type ImportTracksTableRow = {
  key: string
  artist: string
  title: string
  year: string
  releaseTitle: string | null
  replacementFilename: string | null
  betterQualityFound: boolean | null
  fileCount: number
  prep: string
  bestFile: {
    filename: string
    title: string
    artist: string
    recordingDiscogsUrl?: string | null
    recordingMusicBrainzUrl?: string | null
  }
}

function compareImportRows(left: ImportRow, right: ImportRow): number {
  const leftBetter = left.importBetterThanExisting === true ? 1 : 0
  const rightBetter = right.importBetterThanExisting === true ? 1 : 0
  if (leftBetter !== rightBetter) return rightBetter - leftBetter
  if ((left.importQualityScore ?? -1) !== (right.importQualityScore ?? -1)) {
    return (right.importQualityScore ?? -1) - (left.importQualityScore ?? -1)
  }
  if (left.filesize !== right.filesize) return right.filesize - left.filesize
  return left.filename.localeCompare(right.filename)
}

function summarizePrep(rows: ImportRow[]): string {
  const counts = rows.reduce(
    (result, row) => {
      result[row.prep] = (result[row.prep] ?? 0) + 1
      return result
    },
    {} as Record<string, number>
  )
  return ['error', 'processing', 'ready', 'pending']
    .filter((key) => counts[key])
    .map((key) => `${key} ${counts[key]}`)
    .join(' · ')
}

function normalizeGroupText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeGroupTitle(value: string): string {
  return normalizeGroupText(value)
    .replace(/^[a-z]\d+\s+-\s+/i, '')
    .replace(/\s+\d{6,}$/, '')
}

export function buildImportRows(items: CollectionItem[]): ImportRow[] {
  return items.map((item) => {
    const fallback = deriveTrackSummaryFromFilename(item.filename)
    const canonical = item.recordingCanonical
    return {
      ...item,
      artist: canonical?.artist || item.importArtist || fallback.artist,
      title: canonical?.title
        ? `${canonical.title}${canonical.version ? ` (${canonical.version})` : ''}`
        : item.importTitle
          ? `${item.importTitle}${item.importVersion ? ` (${item.importVersion})` : ''}`
          : fallback.title,
      year: canonical?.year || item.importYear || fallback.year,
      prep: item.importStatus ?? 'pending'
    }
  })
}

export function groupImportRows(rows: ImportRow[]): ImportTracksTableRow[] {
  const groups = new Map<string, ImportRow[]>()
  for (const row of rows) {
    const key =
      (row.recordingId != null ? `recording:${row.recordingId}` : null) ||
      row.importTrackKey ||
      `parsed:${normalizeGroupText(row.artist)}:${normalizeGroupTitle(row.title)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const bestFile = [...group].sort(compareImportRows)[0]
      return {
        key,
        artist: bestFile.importMatchArtist || bestFile.artist,
        title: bestFile.importMatchTitle
          ? `${bestFile.importMatchTitle}${bestFile.importMatchVersion ? ` (${bestFile.importMatchVersion})` : ''}`
          : bestFile.title,
        year: bestFile.importMatchYear || bestFile.year,
        releaseTitle: bestFile.importReleaseTitle ?? null,
        replacementFilename:
          group.find((row) => row.importExactExistingFilename)?.importExactExistingFilename ?? null,
        betterQualityFound: group.some((row) => row.importBetterThanExisting === true)
          ? true
          : group.some((row) => row.importBetterThanExisting === false)
            ? false
            : null,
        fileCount: group.length,
        prep: summarizePrep(group),
        bestFile
      }
    })
    .sort((left, right) => compareImportRows(left.bestFile, right.bestFile))
}

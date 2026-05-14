import type { CollectionItem } from '../../../../shared/api'
import { deriveTrackSummaryFromFilename } from '../../lib/music-file.ts'

export type ImportRow = CollectionItem & {
  artist: string
  title: string
  year: string
  prep: string
}

export type ImportTracksTableRow = {
  id: number
  key: string
  artist: string
  title: string
  year: string
  releaseTitle: string | null
  replacementFilename: string | null
  betterQualityFound: boolean | null
  fileCount: number
  files: ImportRow[]
  prep: string
  bestFile: ImportRow
}

function compareImportRows(left: ImportRow, right: ImportRow): number {
  const leftBetter = left.importBetterThanExisting === true ? 1 : 0
  const rightBetter = right.importBetterThanExisting === true ? 1 : 0
  if (leftBetter !== rightBetter) return rightBetter - leftBetter
  if (left.importQualityScore != null && right.importQualityScore != null && left.importQualityScore !== right.importQualityScore) {
    return right.importQualityScore - left.importQualityScore
  }
  if ((left.importQualityScore == null || right.importQualityScore == null) && left.filesize !== right.filesize) {
    return right.filesize - left.filesize
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

function importGroupKey(row: ImportRow): string {
  const matchedTitle = row.importMatchTitle
    ? `${row.importMatchTitle}${row.importMatchVersion ? ` (${row.importMatchVersion})` : ''}`
    : null
  if (row.recordingId != null) return `recording:${row.recordingId}`
  if (row.importMatchArtist && matchedTitle) {
    return `match:${normalizeGroupText(row.importMatchArtist)}:${normalizeGroupTitle(matchedTitle)}`
  }
  return row.importTrackKey || `parsed:${normalizeGroupText(row.artist)}:${normalizeGroupTitle(row.title)}`
}

function importRecordId(key: string): number {
  const recordingId = key.match(/^recording:(\d+)$/)?.[1]
  if (recordingId) return Number(recordingId)
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) || 1
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
    const key = importGroupKey(row)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const bestFile = [...group].sort(compareImportRows)[0]
      return {
        id: importRecordId(key),
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
        files: [...group].sort(compareImportRows),
        prep: summarizePrep(group),
        bestFile
      }
    })
    .sort((left, right) => compareImportRows(left.bestFile, right.bestFile))
}

import type { CollectionItem } from '@djbrain/shared/api'
import { deriveTrackSummaryFromFilename } from '../../lib/music-file.ts'

export type ImportRow = CollectionItem & {
  artist: string
  title: string
  year: string
  prep: string
}

export type ImportTracksTableRow = {
  id: number
  legacyIds: number[]
  key: string
  artist: string
  title: string
  year: string
  releaseTitle: string | null
  replacementFilename: string | null
  betterQualityFound: boolean | null
  fileCount: number
  totalFileCount: number
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

function normalizeGroupPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
}

function hasConflictSuffix(value: string): boolean {
  return /_\d{12,}(?=\.[^/.]+$)/.test(value)
}

function importFileKey(row: ImportRow): string {
  return `${normalizeGroupPath(row.filename).replace(/_\d{12,}(?=\.[^/.]+$)/, '')}:${row.filesize}`
}

function uniqueImportRows(rows: ImportRow[]): ImportRow[] {
  const byFile = new Map<string, ImportRow>()
  for (const row of rows) {
    const existing = byFile.get(importFileKey(row))
    if (!existing || (hasConflictSuffix(existing.filename) && !hasConflictSuffix(row.filename))) byFile.set(importFileKey(row), row)
  }
  return [...byFile.values()]
}

function importGroupKey(row: ImportRow): string {
  if (row.importExactExistingFilename) return `replace:${normalizeGroupPath(row.importExactExistingFilename)}`
  if (row.recordingId != null) return `recording:${row.recordingId}`
  return importFallbackGroupKey(row)
}

function importFallbackGroupKey(row: ImportRow): string {
  const matchedTitle = row.importMatchTitle
    ? `${row.importMatchTitle}${row.importMatchVersion ? ` (${row.importMatchVersion})` : ''}`
    : null
  if (row.importMatchArtist && matchedTitle) {
    return `match:${normalizeGroupText(row.importMatchArtist)}:${normalizeGroupTitle(matchedTitle)}`
  }
  return row.importTrackKey || `parsed:${normalizeGroupText(row.artist)}:${normalizeGroupTitle(row.title)}`
}

function importLegacyGroupKeys(row: ImportRow): string[] {
  return [...new Set([
    importFallbackGroupKey(row),
    `parsed:${normalizeGroupText(row.artist)}:${normalizeGroupTitle(row.title)}`
  ])]
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
      const files = uniqueImportRows(group).sort(compareImportRows)
      const bestFile = files[0]
      const recordingId = group.find((row) => row.recordingId != null)?.recordingId ?? null
      const id = recordingId ?? importRecordId(key)
      const usesRecording = recordingId != null
      const displayFile = usesRecording ? group.find((row) => row.recordingId === recordingId) ?? bestFile : bestFile
      const replacementFilename = group.find((row) => row.importExactExistingFilename)?.importExactExistingFilename ?? null
      return {
        id,
        legacyIds: [...new Set(group.flatMap((row) => [
          importRecordId(key),
          ...importLegacyGroupKeys(row).map(importRecordId),
          ...(row.recordingId != null ? [row.recordingId] : [])
        ]).filter((legacyId) => legacyId !== id))],
        key,
        artist: usesRecording ? displayFile.artist : bestFile.importMatchArtist || bestFile.artist,
        title: !usesRecording && bestFile.importMatchTitle
          ? `${bestFile.importMatchTitle}${bestFile.importMatchVersion ? ` (${bestFile.importMatchVersion})` : ''}`
          : displayFile.title,
        year: usesRecording ? displayFile.year : bestFile.importMatchYear || bestFile.year,
        releaseTitle: bestFile.importReleaseTitle ?? null,
        replacementFilename,
        betterQualityFound: files.some((row) => row.importBetterThanExisting === true)
          ? true
          : files.some((row) => row.importBetterThanExisting === false)
            ? false
            : null,
        fileCount: files.length,
        totalFileCount: files.length + (replacementFilename ? 1 : 0),
        files,
        prep: summarizePrep(files),
        bestFile
      }
    })
    .sort((left, right) => compareImportRows(left.bestFile, right.bestFile))
}

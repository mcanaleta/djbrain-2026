import { extname, isAbsolute, relative } from 'node:path'
import type { CollectionItem, CollectionListResult, WantListAddInput } from './collection-service'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.aiff',
  '.aif',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.alac'
])

type CollectionRow = {
  filename: string
  filesize: number | bigint
  score?: number | null
  importStatus?: CollectionItem['importStatus']
  importArtist?: string | null
  importTitle?: string | null
  importVersion?: string | null
  importYear?: string | null
  importError?: string | null
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected collection sync error'
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return Number(value ?? 0)
}

export function normalizeFilename(value: string): string {
  return value.replace(/[\\/]+/g, '/')
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function tokenizeSearchText(value: string): string[] {
  return [...new Set(normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? [])]
}

export function basenameOfFilename(filename: string): string {
  const normalized = normalizeFilename(filename)
  const lastSlashIndex = normalized.lastIndexOf('/')
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized
}

export function normalizeRelativeFolderPath(value: string): string {
  return normalizeFilename(value).replace(/^\/+/, '').replace(/\/+$/, '')
}

function normalizeWantListText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeWantListOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeWantListText(value)
  return normalized || null
}

export function normalizeWantListInput(input: WantListAddInput): WantListAddInput {
  const artist = normalizeWantListText(input.artist)
  if (!artist) throw new Error('Want list artist is required.')
  const title = normalizeWantListText(input.title)
  if (!title) throw new Error('Want list title is required.')
  return {
    artist,
    title,
    version: normalizeWantListOptionalText(input.version),
    length: normalizeWantListOptionalText(input.length),
    album: normalizeWantListOptionalText(input.album),
    label: normalizeWantListOptionalText(input.label)
  }
}

export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && relativePath !== '..' && !isAbsolute(relativePath))
  )
}

export function isSupportedAudioFile(fileName: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(fileName).toLowerCase())
}

export function getDownloadFolderPrefixes(downloadFolderPaths: string[]): string[] {
  const seen = new Set<string>()
  const prefixes: string[] = []

  for (const rawPath of downloadFolderPaths) {
    const normalizedPath = normalizeRelativeFolderPath(rawPath)
    if (!normalizedPath || normalizedPath === '.' || normalizedPath.startsWith('../') || seen.has(normalizedPath)) {
      continue
    }
    seen.add(normalizedPath)
    prefixes.push(normalizedPath)
  }

  prefixes.sort((left, right) => left.length - right.length)
  return prefixes.filter(
    (prefix, index) =>
      !prefixes.slice(0, index).some((existingPrefix) => prefix === existingPrefix || prefix.startsWith(`${existingPrefix}/`))
  )
}

export function buildPrefixWhereClause(
  columnName: string,
  prefixes: string[]
): { clause: string; params: string[] } {
  const params = prefixes.flatMap((prefix) => [prefix, `${escapeLikePattern(prefix)}/%`])
  return {
    clause: prefixes.map(() => `(${columnName} = ? OR ${columnName} LIKE ? ESCAPE '\\')`).join(' OR '),
    params
  }
}

export function toListResult(rows: CollectionRow[]): CollectionListResult {
  const items = rows.map((row) => ({
    filename: row.filename,
    filesize: toNumber(row.filesize),
    score: typeof row.score === 'number' ? row.score : null,
    importStatus: row.importStatus ?? null,
    importArtist: row.importArtist ?? null,
    importTitle: row.importTitle ?? null,
    importVersion: row.importVersion ?? null,
    importYear: row.importYear ?? null,
    importError: row.importError ?? null
  }))
  return { items, total: items.length }
}

function getSearchTermWeight(term: string): number {
  if (term.length >= 6) return 18
  if (term.length >= 4) return 12
  if (term.length >= 3) return 8
  return 4
}

function countOrderedTermMatches(filenameTerms: string[], queryTerms: string[]): number {
  let matchCount = 0
  let nextIndex = 0

  for (const queryTerm of queryTerms) {
    const matchedIndex = filenameTerms.findIndex(
      (filenameTerm, index) =>
        index >= nextIndex &&
        (filenameTerm === queryTerm ||
          filenameTerm.startsWith(queryTerm) ||
          queryTerm.startsWith(filenameTerm))
    )
    if (matchedIndex === -1) continue
    matchCount += 1
    nextIndex = matchedIndex + 1
  }

  return matchCount
}

function scoreCollectionMatch(filename: string, terms: string[]): number {
  const basename = basenameOfFilename(filename)
  const normalizedBasename = normalizeSearchText(basename)
  const normalizedFilename = normalizeSearchText(filename)
  const basenameTerms = tokenizeSearchText(basename)
  const fullTerms = new Set(tokenizeSearchText(filename))
  const queryText = terms.join(' ')

  let score = 0
  let matchedTerms = 0
  let strongMatches = 0

  for (const term of terms) {
    const weight = getSearchTermWeight(term)

    if (basenameTerms.includes(term)) {
      score += weight * 10
      matchedTerms += 1
      strongMatches += 1
      continue
    }

    if (basenameTerms.some((basenameTerm) => basenameTerm.startsWith(term) || term.startsWith(basenameTerm))) {
      score += weight * 7
      matchedTerms += 1
      strongMatches += 1
      continue
    }

    if (fullTerms.has(term)) {
      score += weight * 4
      matchedTerms += 1
      continue
    }

    if (normalizedFilename.includes(term)) {
      score += weight * 2
      matchedTerms += 1
    }
  }

  if (matchedTerms === 0) return 0
  if (normalizedBasename.includes(queryText)) score += 220
  else if (normalizedFilename.includes(queryText)) score += 120

  score += countOrderedTermMatches(basenameTerms, terms) * 18
  if (strongMatches >= 2) score += strongMatches * 24
  if (strongMatches === terms.length) score += 160
  return score
}

export function filterAndRankRows(rows: CollectionRow[], query: string): CollectionRow[] {
  const terms = tokenizeSearchText(query)
  if (terms.length === 0) {
    return rows.map((row) => ({ ...row, score: null }))
  }

  return rows
    .map((row) => ({ row, score: scoreCollectionMatch(row.filename, terms) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.row.filename.localeCompare(right.row.filename, undefined, { sensitivity: 'base' })
    )
    .map((entry) => ({ ...entry.row, score: entry.score }))
}

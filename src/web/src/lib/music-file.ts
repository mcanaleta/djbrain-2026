import { parseImportFilename } from '../../../shared/import-filename.ts'

export type DerivedTrackSummary = {
  artist: string
  title: string
  year: string
}

function normalizeTrackPart(rawValue: string): string {
  return rawValue.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function fileBasename(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop() ?? filename
}

export function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

export function deriveTrackSummaryFromFilename(filename: string): DerivedTrackSummary {
  const parsed = parseImportFilename(filename)
  if (parsed) {
    return {
      artist: parsed.artist || 'Unknown artist',
      title: parsed.version ? `${parsed.title} (${parsed.version})` : parsed.title,
      year: parsed.year ?? '—'
    }
  }

  const basename = fileBasename(filename)
  const withoutExtension = stripExtension(basename)
  const yearMatch = withoutExtension.match(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/)
  const year = yearMatch?.[1] ?? '—'

  const withoutYear = yearMatch
    ? withoutExtension.replace(new RegExp(`[\\[\\(\\{]?${year}[\\]\\)\\}]?`, 'g'), ' ')
    : withoutExtension

  const normalized = normalizeTrackPart(withoutYear)
  const separatorIndex = normalized.indexOf(' - ')

  if (separatorIndex > 0) {
    return {
      artist: normalizeTrackPart(normalized.slice(0, separatorIndex)) || 'Unknown artist',
      title: normalizeTrackPart(normalized.slice(separatorIndex + 3)) || 'Unknown title',
      year
    }
  }

  return {
    artist: 'Unknown artist',
    title: normalized || 'Unknown title',
    year
  }
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`
  }

  const fractionDigits = value >= 10 ? 1 : 2
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
}

export function formatCompactDuration(seconds: number | null | undefined): string {
  if (!seconds || !isFinite(seconds)) {
    return '—'
  }

  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

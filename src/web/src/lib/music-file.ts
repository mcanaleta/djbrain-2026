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

export function readExtension(filename: string): string {
  const match = filename.match(/(\.[^.\/]+)$/)
  return match?.[1]?.toLowerCase() ?? ''
}

export function formatExtensionName(filename: string): string {
  const ext = readExtension(filename)
  return ext ? ext.slice(1).toUpperCase() : '—'
}

export function joinPath(root: string, filename: string): string {
  return root ? `${root.replace(/\/+$/, '')}/${filename.replace(/^\/+/, '')}` : filename
}

export function formatQualityScore(
  qualityScore: number | null | undefined,
  bitrateKbps?: number | null
): { label: string; title: string } {
  const score = qualityScore == null ? null : Math.round(qualityScore)
  const label = score == null ? '—' : String(score)
  const title =
    score == null
      ? 'No audio analysis score yet'
      : `Analysis score ${score}/100${bitrateKbps != null ? ` · ${Math.round(bitrateKbps)}kbps` : ''}`
  return { label, title }
}

export function formatBitrate(value: number | null | undefined): string {
  return value ? `${value} kbps` : '—'
}

export function formatDb(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(1) : '—'
}

export function formatSignedPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}

export function formatHz(value: number | null): string {
  return value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value} Hz`
}

export function formatBits(value: number | null): string {
  return !value ? '—' : `${value}-bit`
}

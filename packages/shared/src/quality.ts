// ─── Audio Quality ────────────────────────────────────────────────────────────
//
// Isolated quality comparison module.
// Strategy (extensible):
//   1. Format class: lossless > lossy > unknown
//   2. For lossless: file size as quality proxy (larger = more data)
//   3. For lossy: bitrate (kbps) if known, otherwise file size
//
// Future extensions: sample rate, bit depth, codec-specific scoring, etc.

export type AudioFormatClass = 'lossless' | 'lossy' | 'unknown'

// File extension → format class. Lowercase, with leading dot.
const FORMAT_CLASS: Record<string, AudioFormatClass> = {
  '.flac': 'lossless',
  '.aif': 'lossless',
  '.aiff': 'lossless',
  '.wav': 'lossless',
  '.mp3': 'lossy',
  '.aac': 'lossy',
  '.m4a': 'lossy',
  '.ogg': 'lossy'
}

const FORMAT_CLASS_RANK: Record<AudioFormatClass, number> = {
  lossless: 2,
  lossy: 1,
  unknown: 0
}

export type FileQuality = {
  /** Format category: lossless beats lossy */
  formatClass: AudioFormatClass
  /** Raw file size in bytes — used as secondary quality signal */
  fileSizeBytes: number
  /** Bitrate in kbps, if known (from download metadata, ID3 tags, etc.) */
  bitrateKbps: number | null
}

/** Build a FileQuality descriptor from readily-available info */
export function fileQualityFromExt(
  ext: string,
  fileSizeBytes: number,
  bitrateKbps: number | null = null
): FileQuality {
  const formatClass = FORMAT_CLASS[ext.toLowerCase()] ?? 'unknown'
  return { formatClass, fileSizeBytes, bitrateKbps }
}

/**
 * Compute a comparable numeric score — higher means better quality.
 *
 * Weights are chosen so format class strictly dominates, then bitrate
 * strictly dominates within the same class, then file size.
 */
export function qualityScore(q: FileQuality): number {
  // Each tier dominates all lower tiers combined
  const classScore = FORMAT_CLASS_RANK[q.formatClass] * 1_000_000_000_000
  const bitrateScore = (q.bitrateKbps ?? 0) * 1_000_000
  const sizeScore = q.fileSizeBytes // bytes, up to ~1 GB max
  return classScore + bitrateScore + sizeScore
}

export type QualityComparison = 'better' | 'worse' | 'same'

/** Compare two files: is `candidate` better, worse, or the same quality as `existing`? */
export function compareQuality(
  candidate: FileQuality,
  existing: FileQuality
): QualityComparison {
  const diff = qualityScore(candidate) - qualityScore(existing)
  if (diff > 0) return 'better'
  if (diff < 0) return 'worse'
  return 'same'
}

/** Human-readable quality summary for logging */
export function qualitySummary(q: FileQuality): string {
  const parts: string[] = [q.formatClass]
  if (q.bitrateKbps !== null) parts.push(`${q.bitrateKbps}kbps`)
  parts.push(`${(q.fileSizeBytes / 1_000_000).toFixed(1)}MB`)
  return parts.join(' ')
}

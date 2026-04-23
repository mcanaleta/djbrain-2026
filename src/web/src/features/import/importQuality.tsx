import type { CSSProperties } from 'react'
import type { AudioAnalysis } from '../../../../shared/api'
import { formatBitrate, formatBits, formatCompactDuration, formatDb, formatHz, formatPercent, formatSignedPercent } from '../../lib/music-file'

export const IMPORT_FILE_METRICS = [
  'len',
  'size',
  'quality',
  'format',
  'bitrate',
  'rate',
  'bits',
  'topend',
  'crest',
  'noise',
  'cutoff',
  'rumble',
  'hum',
  'vinyl'
] as const

export type ImportFileMetricKey = (typeof IMPORT_FILE_METRICS)[number]

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function qualityIntensity(key: ImportFileMetricKey, analysis: AudioAnalysis | null): number {
  if (!analysis) return 0
  const formatScore = (({ wav: 1, aiff: 1, aif: 1, flac: 0.95, alac: 0.95, m4a: 0.65, aac: 0.65, ogg: 0.6, opus: 0.6, mp3: 0.45 } as Record<string, number>)[analysis.format.toLowerCase()] ?? 0)
  if (key === 'format') return clamp01(formatScore)
  if (key === 'bitrate') return clamp01((analysis.bitrateKbps ?? 0) / 320)
  if (key === 'rate') return clamp01((analysis.sampleRateHz ?? 0) / 48000)
  if (key === 'bits') return analysis.bitDepth ? clamp01(analysis.bitDepth / 24) : formatScore
  if (key === 'topend') return clamp01((analysis.topEndHz ?? 0) / 20000)
  if (key === 'crest') return clamp01((analysis.crestDb ?? 0) / 16)
  if (key === 'quality') return clamp01((((analysis.bitrateKbps ?? 0) / 320) + formatScore) / 2)
  return 0
}

function issueIntensity(key: ImportFileMetricKey, analysis: AudioAnalysis | null): number {
  if (!analysis) return 0
  if (key === 'noise') return clamp01((analysis.noiseScore ?? 0) / 100)
  if (key === 'cutoff') return clamp01(((analysis.cutoffDb ?? 0) - 6) / 18)
  if (key === 'rumble') return clamp01((analysis.rumbleScore ?? 0) / 100)
  if (key === 'hum') return clamp01((analysis.humScore ?? 0) / 100)
  if (key === 'vinyl') return clamp01((analysis.vinylLikelihood ?? 0) / 100)
  return 0
}

export function metricBar(key: ImportFileMetricKey, analysis: AudioAnalysis | null): { width: string; className: string } | null {
  const intensity = ['noise', 'cutoff', 'rumble', 'hum', 'vinyl'].includes(key)
    ? issueIntensity(key, analysis)
    : qualityIntensity(key, analysis)
  return intensity > 0
    ? { width: `${Math.round(intensity * 100)}%`, className: ['noise', 'cutoff', 'rumble', 'hum', 'vinyl'].includes(key) ? 'bg-rose-500/75' : 'bg-emerald-500/75' }
    : null
}

export function formatImportMetric(
  key: ImportFileMetricKey,
  analysis: AudioAnalysis | null,
  fallback: { duration: number | null; filesize: number; qualityScore: number | null; bitrateKbps: number | null; filename?: string | null }
): string {
  if (key === 'len') return formatCompactDuration(fallback.duration)
  if (key === 'size') return fallback.filesize > 0 ? `${(fallback.filesize / 1024 / 1024).toFixed(1)}M` : '—'
  if (key === 'quality') return fallback.qualityScore == null ? '—' : `${Math.round(fallback.qualityScore)}`
  if (!analysis) return '—'
  if (key === 'format') {
    const ext = fallback.filename?.match(/\.([^.\/]+)$/)?.[1]?.toUpperCase() ?? analysis.format.toUpperCase()
    return `${ext}${analysis.codec ? `/${analysis.codec}` : ''}`
  }
  if (key === 'bitrate') return formatBitrate(analysis.bitrateKbps ?? fallback.bitrateKbps)
  if (key === 'rate') return formatHz(analysis.sampleRateHz)
  if (key === 'bits') return formatBits(analysis.bitDepth)
  if (key === 'topend') return formatHz(analysis.topEndHz)
  if (key === 'crest') return formatDb(analysis.crestDb)
  if (key === 'noise') return formatPercent(analysis.noiseScore)
  if (key === 'cutoff') return formatDb(analysis.cutoffDb)
  if (key === 'rumble') return formatPercent(analysis.rumbleScore)
  if (key === 'hum') return formatPercent(analysis.humScore)
  if (key === 'vinyl') return formatPercent(analysis.vinylLikelihood)
  return '—'
}

export function metricCellStyle(key: ImportFileMetricKey, analysis: AudioAnalysis | null): CSSProperties | undefined {
  const bar = metricBar(key, analysis)
  return bar ? { backgroundColor: bar.className.includes('rose') ? 'rgba(244,63,94,0.08)' : 'rgba(34,197,94,0.08)' } : undefined
}

export function formatLengthWithDeviation(
  durationSeconds: number | null | undefined,
  referenceDurationSeconds: number | null | undefined
): string {
  const duration = formatCompactDuration(durationSeconds)
  if (!durationSeconds || !referenceDurationSeconds || !isFinite(durationSeconds) || !isFinite(referenceDurationSeconds) || referenceDurationSeconds <= 0) {
    return duration
  }
  const deviation = ((durationSeconds - referenceDurationSeconds) / referenceDurationSeconds) * 100
  return `${duration} ${formatSignedPercent(deviation)}`
}

export function lengthDeviationBar(
  durationSeconds: number | null | undefined,
  referenceDurationSeconds: number | null | undefined
): { width: string; className: string } | null {
  if (!durationSeconds || !referenceDurationSeconds || !isFinite(durationSeconds) || !isFinite(referenceDurationSeconds) || referenceDurationSeconds <= 0) {
    return null
  }
  const delta = Math.abs(((durationSeconds - referenceDurationSeconds) / referenceDurationSeconds) * 100)
  if (delta <= 1) return { width: '100%', className: 'bg-emerald-500/75' }
  if (delta <= 3) return { width: `${Math.round((delta / 3) * 100)}%`, className: 'bg-amber-500/75' }
  return { width: `${Math.round(clamp01(delta / 12) * 100)}%`, className: 'bg-rose-500/75' }
}

export function MetricValueCell({
  value,
  bar
}: {
  value: string
  bar: { width: string; className: string } | null
}): React.JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-sm bg-zinc-900/70 px-1.5 py-0.5">
      {bar ? <div className={`absolute inset-y-0 left-0 ${bar.className}`} style={{ width: bar.width }} /> : null}
      <span className="relative z-10">{value}</span>
    </div>
  )
}

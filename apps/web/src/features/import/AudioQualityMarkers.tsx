import type { AudioAnalysis } from '@djbrain/shared/api'
import { formatBits, formatBitrate, formatDb, formatHz, formatPercent } from '../../lib/music-file'

export const AUDIO_QUALITY_MARKERS = [
  ['format', 'Format'],
  ['bitrate', 'Bitrate'],
  ['rate', 'Rate'],
  ['bits', 'Bits'],
  ['maxfreq', 'Top'],
  ['crest', 'Crest'],
  ['air', 'Air'],
  ['noise', 'Noise'],
  ['cutoff', 'Cutoff'],
  ['rumble', 'Rumble'],
  ['hum', 'Hum'],
  ['vinyl', 'Vinyl']
] as const

export type AudioQualityMarkerKey = (typeof AUDIO_QUALITY_MARKERS)[number][0]

const ISSUE_KEYS = new Set<AudioQualityMarkerKey>(['noise', 'cutoff', 'rumble', 'hum', 'vinyl'])
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const formatStrength = (format: string): number => ({ wav: 1, aiff: 1, aif: 1, flac: 0.95, alac: 0.95, m4a: 0.65, aac: 0.65, ogg: 0.6, opus: 0.6, mp3: 0.45 } as Record<string, number>)[format.toLowerCase()] ?? 0

function intensity(key: AudioQualityMarkerKey, analysis: AudioAnalysis | null): number {
  if (!analysis) return 0
  const formatScore = formatStrength(analysis.format)
  if (key === 'format') return clamp01(formatScore)
  if (key === 'bitrate') return clamp01((analysis.bitrateKbps ?? 0) / 320)
  if (key === 'rate') return clamp01((analysis.sampleRateHz ?? 0) / 48000)
  if (key === 'bits') return analysis.bitDepth ? clamp01(analysis.bitDepth / 24) : formatScore
  if (key === 'maxfreq') return clamp01((maxFrequencyHz(analysis) ?? 0) / 22050)
  if (key === 'crest') return clamp01((analysis.crestDb ?? 0) / 16)
  if (key === 'air') return clamp01(((analysis.airBandRmsDb ?? -64) + 58) / 22)
  if (key === 'noise') return clamp01((analysis.noiseScore ?? 0) / 100)
  if (key === 'cutoff') return clamp01(((analysis.cutoffDb ?? 0) - 6) / 18)
  if (key === 'rumble') return clamp01((analysis.rumbleScore ?? 0) / 100)
  if (key === 'hum') return clamp01((analysis.humScore ?? 0) / 100)
  return clamp01((analysis.vinylLikelihood ?? 0) / 100)
}

export function formatAudioQualityMarker(key: AudioQualityMarkerKey, analysis: AudioAnalysis | null): string {
  if (!analysis) return '—'
  if (key === 'format') return `${analysis.format.toUpperCase()}${analysis.codec ? `/${analysis.codec}` : ''}`
  if (key === 'bitrate') return formatBitrate(analysis.bitrateKbps)
  if (key === 'rate') return formatHz(analysis.sampleRateHz)
  if (key === 'bits') return formatBits(analysis.bitDepth)
  if (key === 'maxfreq') return formatHz(maxFrequencyHz(analysis))
  if (key === 'crest') return `${formatDb(analysis.crestDb)} dB`
  if (key === 'air') return `${formatDb(analysis.airBandRmsDb)} dB`
  if (key === 'noise') return formatPercent(analysis.noiseScore)
  if (key === 'cutoff') return `${formatDb(analysis.cutoffDb)} dB`
  if (key === 'rumble') return formatPercent(analysis.rumbleScore)
  if (key === 'hum') return formatPercent(analysis.humScore)
  return formatPercent(analysis.vinylLikelihood)
}

function maxFrequencyHz(analysis: AudioAnalysis): number | null {
  if (typeof analysis.maxFrequencyHz === 'number') return analysis.maxFrequencyHz
  const nyquist = analysis.sampleRateHz ? analysis.sampleRateHz / 2 : null
  const format = analysis.format.toLowerCase()
  const bitrate = analysis.bitrateKbps ?? 0
  const bitrateCeiling =
    ['flac', 'wav', 'aiff', 'aif', 'alac'].includes(format) ? nyquist
      : format === 'mp3' ? (bitrate >= 256 ? 20000 : bitrate >= 192 ? 18000 : bitrate >= 128 ? 16000 : bitrate > 0 ? 15000 : null)
        : ['aac', 'm4a', 'ogg', 'opus'].includes(format) ? (bitrate >= 192 ? 20000 : bitrate >= 128 ? 18000 : bitrate > 0 ? 16000 : null)
          : null
  const cutoffCeiling = analysis.cutoffDb == null ? null : analysis.cutoffDb >= 18 ? 16000 : analysis.cutoffDb >= 12 ? 18000 : analysis.cutoffDb >= 8 ? 20000 : null
  const value = [nyquist, bitrateCeiling, cutoffCeiling].filter((item): item is number => item != null && Number.isFinite(item))
  return value.length ? Math.round(Math.min(...value) / 1000) * 1000 : null
}

export function AudioQualityMarkerCell({ marker, analysis }: { marker: AudioQualityMarkerKey; analysis: AudioAnalysis | null }): React.JSX.Element {
  const value = intensity(marker, analysis)
  const bar = value > 0 ? { width: `${Math.round(value * 100)}%`, className: ISSUE_KEYS.has(marker) ? 'bg-rose-500/75' : 'bg-emerald-500/75' } : null
  return (
    <div className="relative overflow-hidden rounded-sm bg-zinc-900/70 px-1.5 py-0.5">
      {bar ? <div className={`absolute inset-y-0 left-0 ${bar.className}`} style={{ width: bar.width }} /> : null}
      <span className="relative z-10">{formatAudioQualityMarker(marker, analysis)}</span>
    </div>
  )
}

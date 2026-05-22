import type { AudioAnalysis } from '@djbrain/shared/api'
import { formatBits, formatBitrate, formatDb, formatHz, formatPercent } from '../../lib/music-file'

export const AUDIO_QUALITY_MARKERS = [
  ['format', 'Format', 'Container and codec. Lossless formats score high as sources, but imports/replacements are still written as MP3 320 for Rekordbox/CDJ compatibility.'],
  ['bitrate', 'Bitrate', 'Encoded bitrate in kbps. For lossy files, 320 kbps is the normal target; lower values often mean less detail or more compression artifacts.'],
  ['rate', 'Rate', 'Sample rate in Hz/kHz. 44.1 kHz is CD quality; higher values can preserve more ultrasonic content but do not guarantee a better master.'],
  ['bits', 'Bits', 'Bit depth when available. 16-bit is CD quality; 24-bit can be useful for masters/lossless sources, but many lossy files do not report real bit depth.'],
  ['maxfreq', 'Top', 'Estimated highest useful frequency. Around 16 kHz often suggests 128 kbps/lower-quality lossy audio; 18-20 kHz is more typical of stronger MP3/AAC; 22 kHz usually means full 44.1 kHz bandwidth.'],
  ['crest', 'Crest', 'Peak-to-average level gap in dB. Higher crest means more punch/transients and less brickwall limiting; very low crest means the file is probably over-compressed or clipped.'],
  ['air', 'Air', 'RMS energy above 12 kHz in dB. Less negative values mean more high-end sparkle/open top; very negative values mean dull, rolled-off, low-pass, or weak high-frequency content.'],
  ['noise', 'Noise', 'High-frequency dirt score from the intro. Higher values mean more hiss, codec fizz, vinyl crackle, or noisy top-end content. This is an issue marker: lower is better.'],
  ['cutoff', 'Cutoff', 'How sharply the top end drops above 12 kHz compared with the upper mids. Higher values often flag low-pass filtering, bad transcodes, or bandwidth-limited rips. Lower is better.'],
  ['rumble', 'Rumble', 'Sub-35 Hz unwanted low-end weight in the intro. Higher values suggest turntable rumble, handling noise, or bad low-frequency cleanup. Lower is better.'],
  ['hum', 'Hum', '50/100 Hz mains-style contamination in the intro. Higher values suggest electrical hum or grounding noise. Lower is better.'],
  ['vinyl', 'Vinyl', 'Heuristic vinyl-rip likelihood based on intro noise, rumble, hum, and high-end behavior. Higher means more analog/vinyl-like artifacts; it is not automatically bad, but it is a warning.']
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

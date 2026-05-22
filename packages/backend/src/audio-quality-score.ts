import type { AudioAnalysis } from '@djbrain/shared/api.ts'

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

function weightedAverage(values: Array<{ value: number | null; weight: number }>): number | null {
  const valid = values.filter((item): item is { value: number; weight: number } => item.value !== null)
  const weight = valid.reduce((sum, item) => sum + item.weight, 0)
  return weight > 0 ? valid.reduce((sum, item) => sum + item.value * item.weight, 0) / weight : null
}

function formatStrength(format: string | null | undefined): number | null {
  return format ? ({ wav: 1, aiff: 1, aif: 1, flac: 0.95, alac: 0.95, m4a: 0.65, aac: 0.65, ogg: 0.6, opus: 0.6, mp3: 0.45 } as Record<string, number>)[format.toLowerCase()] ?? 0.5 : null
}

export function computeAnalysisQualityScore(analysis: AudioAnalysis | null): number | null {
  if (!analysis) return null
  const quality = weightedAverage([
    { value: formatStrength(analysis.format), weight: 0.28 },
    { value: analysis.bitrateKbps == null ? null : clamp01(analysis.bitrateKbps / 320), weight: 0.22 },
    { value: analysis.sampleRateHz == null ? null : clamp01(analysis.sampleRateHz / 48000), weight: 0.12 },
    { value: analysis.bitDepth == null ? formatStrength(analysis.format) : clamp01(analysis.bitDepth / 24), weight: 0.12 },
    { value: analysis.crestDb == null ? null : clamp01(analysis.crestDb / 16), weight: 0.14 },
    { value: analysis.airBandRmsDb == null ? null : clamp01((analysis.airBandRmsDb + 58) / 22), weight: 0.12 }
  ])
  const issues = weightedAverage([
    { value: analysis.noiseScore == null ? null : clamp01(analysis.noiseScore / 100), weight: 0.35 },
    { value: analysis.cutoffDb == null ? null : clamp01((analysis.cutoffDb - 6) / 18), weight: 0.25 },
    { value: analysis.rumbleScore == null ? null : clamp01(analysis.rumbleScore / 100), weight: 0.15 },
    { value: analysis.humScore == null ? null : clamp01(analysis.humScore / 100), weight: 0.1 },
    { value: analysis.vinylLikelihood == null ? null : clamp01(analysis.vinylLikelihood / 100), weight: 0.15 }
  ]) ?? 0
  return quality == null ? null : Math.round(clamp01(quality * 0.72 + (1 - issues) * 0.28) * 100)
}

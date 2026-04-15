import type { CSSProperties } from 'react'
import type { AudioAnalysis, CollectionItem, ImportReview } from '../../../shared/api'
import { formatCompactDuration } from '../lib/music-file'
import { guessMeta, guessYear, withVersion } from '../lib/importReview'

const COMPARISON_KEYS = new Set(['artist', 'title', 'year', 'len'])
const ISSUE_KEYS = new Set(['noise', 'cutoff', 'rumble', 'hum', 'vinyl'])

type CompareMeta = { artist: string; title: string; year: string; len: number | null }

function formatDb(value: number | null, digits: number = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)} dB`
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${value} kbps`
}

function formatHz(value: number | null): string {
  return value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value} Hz`
}

function formatBits(value: number | null): string {
  return !value ? '—' : `${value}-bit`
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function textDifference(a: string, b: string): number {
  const left = normText(a)
  const right = normText(b)
  if (!left || !right || left === right) return 0
  if (left.includes(right) || right.includes(left)) return 0.35
  const leftWords = new Set(left.split(' '))
  const rightWords = new Set(right.split(' '))
  let overlap = 0
  for (const word of leftWords) if (rightWords.has(word)) overlap += 1
  return clamp01(1 - overlap / Math.max(leftWords.size, rightWords.size, 1))
}

function mismatchIntensity(key: string, rowMeta: CompareMeta, referenceMeta: CompareMeta | null): number {
  if (!referenceMeta) return 0
  if (key === 'artist') return textDifference(rowMeta.artist, referenceMeta.artist)
  if (key === 'title') return textDifference(rowMeta.title, referenceMeta.title)
  if (key === 'year') return clamp01(Math.abs(Number(rowMeta.year) - Number(referenceMeta.year)) / 10)
  if (key === 'len') return rowMeta.len === null || referenceMeta.len === null ? 0 : clamp01(Math.abs(rowMeta.len - referenceMeta.len) / 20)
  return 0
}

function qualityIntensity(key: string, analysis: AudioAnalysis | null): number {
  if (COMPARISON_KEYS.has(key) || !analysis) return 0
  const formatScore = (({ wav: 1, aiff: 1, aif: 1, flac: 0.95, alac: 0.95, m4a: 0.65, aac: 0.65, ogg: 0.6, opus: 0.6, mp3: 0.45 } as Record<string, number>)[analysis.format.toLowerCase()] ?? 0)
  if (key === 'format') return clamp01(formatScore)
  if (key === 'bitrate') return clamp01((analysis.bitrateKbps ?? 0) / 320)
  if (key === 'rate') return clamp01((analysis.sampleRateHz ?? 0) / 48000)
  if (key === 'bits') return analysis.bitDepth ? clamp01(analysis.bitDepth / 24) : formatScore
  if (key === 'crest') return clamp01((analysis.crestDb ?? 0) / 16)
  if (key === 'air') return clamp01(((analysis.airBandRmsDb ?? -64) + 58) / 22)
  return 0
}

function issueIntensity(key: string, analysis: AudioAnalysis | null): number {
  if (!analysis) return 0
  if (key === 'noise') return clamp01((analysis.noiseScore ?? 0) / 100)
  if (key === 'cutoff') return clamp01(((analysis.cutoffDb ?? 0) - 6) / 18)
  if (key === 'rumble') return clamp01((analysis.rumbleScore ?? 0) / 100)
  if (key === 'hum') return clamp01((analysis.humScore ?? 0) / 100)
  if (key === 'vinyl') return clamp01((analysis.vinylLikelihood ?? 0) / 100)
  return 0
}

function fileCellStyle(key: string, rowMeta: CompareMeta, referenceMeta: CompareMeta | null): CSSProperties | undefined {
  const mismatch = mismatchIntensity(key, rowMeta, referenceMeta)
  return COMPARISON_KEYS.has(key) && mismatch > 0 ? { backgroundColor: `rgba(244,63,94,${0.08 + mismatch * 0.55})` } : undefined
}

function metricBar(key: string, analysis: AudioAnalysis | null): { width: string; className: string } | null {
  if (!analysis || COMPARISON_KEYS.has(key)) return null
  const intensity = ISSUE_KEYS.has(key) ? issueIntensity(key, analysis) : qualityIntensity(key, analysis)
  if (intensity <= 0) return null
  return { width: `${Math.round(intensity * 100)}%`, className: ISSUE_KEYS.has(key) ? 'bg-rose-500/75' : 'bg-emerald-500/75' }
}

function MetricValueCell({
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

function formatOverviewValue(key: string, analysis: AudioAnalysis | null): string {
  if (!analysis) return '—'
  if (key === 'len') return formatCompactDuration(analysis.durationSeconds ?? null)
  if (key === 'format') return `${analysis.format.toUpperCase()}${analysis.codec ? `/${analysis.codec}` : ''}`
  if (key === 'bitrate') return formatRate(analysis.bitrateKbps)
  if (key === 'rate') return formatHz(analysis.sampleRateHz)
  if (key === 'bits') return formatBits(analysis.bitDepth)
  if (key === 'crest') return formatDb(analysis.crestDb)
  if (key === 'noise') return formatPercent(analysis.noiseScore)
  if (key === 'air') return formatDb(analysis.airBandRmsDb)
  if (key === 'cutoff') return formatDb(analysis.cutoffDb)
  if (key === 'rumble') return formatPercent(analysis.rumbleScore)
  if (key === 'hum') return formatPercent(analysis.humScore)
  if (key === 'vinyl') return formatPercent(analysis.vinylLikelihood)
  return '—'
}

function formatReferenceValue(key: string, meta: CompareMeta | null): string {
  if (!meta) return '—'
  if (key === 'artist') return meta.artist
  if (key === 'title') return meta.title
  if (key === 'year') return meta.year
  if (key === 'len') return formatCompactDuration(meta.len)
  return '—'
}

export function ImportReviewOverviewTable({
  filename,
  parsed,
  sourceAnalysis,
  selectedCandidate,
  selectedItem,
  existingAnalysis
}: {
  filename: string
  parsed: ImportReview['parsed']
  sourceAnalysis: AudioAnalysis | null
  selectedCandidate: ImportReview['candidates'][number] | null
  selectedItem: CollectionItem | null
  existingAnalysis: AudioAnalysis | null
}): React.JSX.Element {
  const guessedSourceMeta = guessMeta(filename)
  const sourceMeta = {
    artist: parsed?.artist || guessedSourceMeta.artist,
    title: parsed ? withVersion(parsed.title, parsed.version) : guessedSourceMeta.title,
    year: guessYear(filename),
    len: sourceAnalysis?.durationSeconds ?? null
  }
  const guessedExistingMeta = selectedItem ? guessMeta(selectedItem.filename) : null
  const existingMeta = guessedExistingMeta ? { ...guessedExistingMeta, len: existingAnalysis?.durationSeconds ?? selectedItem?.duration ?? null } : null
  const discogsMeta = selectedCandidate
    ? {
        artist: selectedCandidate.match.artist,
        title: withVersion(selectedCandidate.match.title, selectedCandidate.match.version),
        year: selectedCandidate.match.year ?? '—',
        len: selectedCandidate.match.durationSeconds ?? null
      }
    : null
  const cols = [
    ['artist', 'Artist', 'Artist name. File rows turn red when they differ from the selected Discogs match.'],
    ['title', 'Title', 'Track title. File rows turn red when they differ from the selected Discogs match.'],
    ['year', 'Year', 'Release year. File rows turn red when they differ from the selected Discogs match.'],
    ['len', 'Len', 'Track duration. Large differences against Discogs often mean a different edit, bad rip, or pitch change.'],
    ['format', 'Format', 'File format and codec quality baseline. Greener means a stronger source format.'],
    ['bitrate', 'Bitrate', 'Encoded kbps. Higher is usually better for lossy files.'],
    ['rate', 'Rate', 'Sample rate. Higher usually preserves more high-frequency detail.'],
    ['crest', 'Crest', 'Peak-to-RMS gap. Higher usually means more punch and less brickwall limiting.'],
    ['air', 'Air', 'Energy above 12 kHz. Higher usually means a more open, less rolled-off top end.'],
    ['noise', 'Noise', 'Top-end dirt score from the first 30s. Higher means hissier or noisier highs.'],
    ['cutoff', 'Cutoff', 'Gap between 4 kHz+ and 12 kHz+ energy. Higher often means lossy/transcoded or rolled-off highs.'],
    ['rumble', 'Rumble', 'First-30s sub-bass severity. Higher means more unwanted sub-35 Hz weight under the musical bass.'],
    ['hum', 'Hum', 'First-30s 50/100 Hz mains severity. Higher means more power-line style low-frequency contamination.'],
    ['vinyl', 'Vinyl', 'Heuristic vinyl-rip likelihood from first-30s noise, rumble, and hum. Higher means more analog/vinyl-like.']
  ] as const

  return (
    <div className="overflow-x-auto border-b border-zinc-800 pb-2">
      <table className="min-w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500">
            <th className="px-2 py-1 text-left font-medium">File</th>
            {cols.map(([key, label, tip]) => (
              <th key={key} className="px-2 py-1 text-left font-medium">
                <span title={tip} className="cursor-help border-b border-dotted border-zinc-700/70">{label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-zinc-800/70 text-zinc-200">
            <td className="max-w-[280px] truncate px-2 py-1.5 font-medium">{filename}</td>
            {cols.map(([key]) => (
              <td key={key} className="max-w-[180px] truncate px-2 py-1.5" style={fileCellStyle(key, sourceMeta, discogsMeta ?? existingMeta)}>
                {COMPARISON_KEYS.has(key)
                  ? formatReferenceValue(key, sourceMeta)
                  : <MetricValueCell value={formatOverviewValue(key, sourceAnalysis)} bar={metricBar(key, sourceAnalysis)} />}
              </td>
            ))}
          </tr>
          <tr className="text-zinc-300">
            <td className="max-w-[280px] truncate px-2 py-1.5 font-medium">{selectedItem?.filename ?? 'Compare target'}</td>
            {cols.map(([key]) => (
              <td key={key} className="max-w-[180px] truncate px-2 py-1.5" style={!selectedItem || !existingMeta ? undefined : fileCellStyle(key, existingMeta, discogsMeta)}>
                {!selectedItem || !existingMeta
                  ? '—'
                  : COMPARISON_KEYS.has(key)
                    ? formatReferenceValue(key, existingMeta)
                    : <MetricValueCell value={formatOverviewValue(key, existingAnalysis)} bar={metricBar(key, existingAnalysis)} />}
              </td>
            ))}
          </tr>
          {selectedCandidate ? (
            <tr className="border-t border-zinc-800/70 text-zinc-400">
              <td className="max-w-[280px] truncate px-2 py-1.5 font-medium" title={selectedCandidate.match.releaseTitle}>Discogs · {selectedCandidate.match.releaseTitle}</td>
              {cols.map(([key]) => (
                <td key={key} className="max-w-[180px] truncate px-2 py-1.5">
                  {formatReferenceValue(key, discogsMeta)}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

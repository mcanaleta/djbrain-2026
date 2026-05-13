import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Link1Icon, LinkBreak2Icon, PauseIcon, PlayIcon } from '@radix-ui/react-icons'
import type {
  CollectionItem,
  AudioAnalysis,
  ImportComparison,
  ImportFileResult,
  ImportReview,
  ImportReviewSearch,
  ImportTagPreview
} from '../../../shared/api'
import { api } from '../api/client'
import { localFileUrl } from '../context/PlayerContext'
import { formatCompactDuration } from '../lib/music-file'
import { ActionButton, DataTable, Notice, Pill, type DataTableColumn } from './view'

type TagDraft = Record<keyof ImportTagPreview, string>
type SearchDraft = { artist: string; title: string; version: string }
type PlayMode = 'stopped' | 'source' | 'existing' | 'both'
type ReviewCandidate = ImportReview['candidates'][number]
type LoadReviewOptions = { preserveTagDraft?: boolean; force?: boolean }

const EMPTY_TAG_DRAFT: TagDraft = {
  artist: '',
  title: '',
  album: '',
  year: '',
  label: '',
  catalogNumber: '',
  trackPosition: '',
  discogsReleaseId: '',
  discogsTrackPosition: ''
}

const TAG_KEYS = Object.keys(EMPTY_TAG_DRAFT) as Array<keyof TagDraft>

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected import review error'
}

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

function toSearchDraft(search: ImportReviewSearch | null | undefined): SearchDraft {
  return {
    artist: search?.artist ?? '',
    title: search?.title ?? '',
    version: search?.version ?? ''
  }
}

function toSearchInput(search: SearchDraft): ImportReviewSearch {
  return {
    artist: search.artist.trim(),
    title: search.title.trim(),
    version: search.version.trim() || null
  }
}

function summarizeMediaType(value: string | null | undefined): string {
  const normalized = value?.toLowerCase() ?? ''
  if (!normalized) return '—'
  if (/\bvinyl|vinilo|12"|10"|7"|45 ?rpm|33 ?rpm\b/.test(normalized)) return 'Vinyl'
  if (/\bcd|cdm|compact disc\b/.test(normalized)) return 'CD'
  if (/\bcassette|tape\b/.test(normalized)) return 'Tape'
  if (/\bfile|digital|web|bandcamp|beatport|traxsource\b/.test(normalized)) return 'WEB'
  return value?.split(' · ')[0] ?? '—'
}

function toTagDraft(tags: ImportTagPreview | null | undefined): TagDraft {
  return {
    artist: tags?.artist ?? '',
    title: tags?.title ?? '',
    album: tags?.album ?? '',
    year: tags?.year ?? '',
    label: tags?.label ?? '',
    catalogNumber: tags?.catalogNumber ?? '',
    trackPosition: tags?.trackPosition ?? '',
    discogsReleaseId: tags?.discogsReleaseId?.toString() ?? '',
    discogsTrackPosition: tags?.discogsTrackPosition ?? ''
  }
}

function toTagPreview(draft: TagDraft): ImportTagPreview {
  const text = (value: string): string | null => {
    const normalized = value.trim()
    return normalized || null
  }
  const number = (value: string): number | null => {
    const normalized = value.trim()
    if (!normalized) return null
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    artist: text(draft.artist),
    title: text(draft.title),
    album: text(draft.album),
    year: text(draft.year),
    label: text(draft.label),
    catalogNumber: text(draft.catalogNumber),
    trackPosition: text(draft.trackPosition),
    discogsReleaseId: number(draft.discogsReleaseId),
    discogsTrackPosition: text(draft.discogsTrackPosition)
  }
}

function mergeTagDraft(current: TagDraft, fallback: TagDraft, dirty: Partial<Record<keyof TagDraft, boolean>>): TagDraft {
  return Object.fromEntries(TAG_KEYS.map((key) => [key, dirty[key] ? current[key] : fallback[key]])) as TagDraft
}

function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
}

function buildDestinationPreview(filename: string, candidatePath: string | null, version: string | null, tags: TagDraft): string {
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? ''
  const [songsFolder = 'songs'] = (candidatePath ?? 'songs').split('/')
  const year = sanitizeFilenameSegment(tags.year) || 'unknown'
  const artist = sanitizeFilenameSegment(tags.artist) || 'Unknown artist'
  const title = sanitizeFilenameSegment(tags.title) || 'Unknown title'
  return `${songsFolder}/${year}/${artist} - ${title}${version ? ` (${sanitizeFilenameSegment(version)})` : ''}${ext}`
}

function guessYear(path: string): string {
  return path.match(/(?:^|\/)(19|20)\d{2}(?:\/|$)/)?.[0]?.replaceAll('/', '') ?? '—'
}

function guessMeta(path: string): { artist: string; title: string; year: string } {
  const normalized = path.replace(/\.[^.]+$/, '').split('/').pop() ?? path
  const match = normalized.match(/^(.*?) - (.*)$/)
  return {
    artist: match?.[1]?.trim() || '—',
    title: match?.[2]?.trim() || normalized,
    year: guessYear(path)
  }
}

function withVersion(title: string, version?: string | null): string {
  return version ? `${title} (${version})` : title
}

function candidateKey(candidate: ReviewCandidate | null): string | null {
  return candidate ? `${candidate.match.releaseId}:${candidate.match.trackPosition ?? ''}:${candidate.match.title}` : null
}

function pickSelectedCandidateIndex(review: ImportReview, currentKey: string | null): number | null {
  if (currentKey) {
    const matchIndex = review.candidates.findIndex((candidate) => candidateKey(candidate) === currentKey)
    if (matchIndex !== -1) return matchIndex
  }
  return review.selectedCandidateIndex
}

function pickExistingFilename(
  review: ImportReview,
  candidate: ReviewCandidate | null,
  currentFilename: string | null
): string | null {
  const filenames = new Set(review.similarItems.map((item) => item.filename))
  if (candidate?.exactExistingFilename && filenames.has(candidate.exactExistingFilename)) return candidate.exactExistingFilename
  if (currentFilename && filenames.has(currentFilename)) return currentFilename
  return review.similarItems[0]?.filename ?? null
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

const COMPARISON_KEYS = new Set(['artist', 'title', 'year', 'len'])
const ISSUE_KEYS = new Set(['noise', 'cutoff', 'rumble', 'hum', 'vinyl'])

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
  for (const word of leftWords) if (rightWords.has(word)) overlap++
  return clamp01(1 - overlap / Math.max(leftWords.size, rightWords.size, 1))
}

type CompareMeta = { artist: string; title: string; year: string; len: number | null }

function mismatchIntensity(key: string, rowMeta: CompareMeta, referenceMeta: CompareMeta | null): number {
  if (!referenceMeta) return 0
  if (key === 'artist') return textDifference(rowMeta.artist, referenceMeta.artist)
  if (key === 'title') return textDifference(rowMeta.title, referenceMeta.title)
  if (key === 'year') return clamp01(Math.abs(Number(rowMeta.year) - Number(referenceMeta.year)) / 10)
  if (key === 'len') return rowMeta.len === null || referenceMeta.len === null ? 0 : clamp01(Math.abs(rowMeta.len - referenceMeta.len) / 20)
  return 0
}

function qualityIntensity(key: string, analysis: AudioAnalysis | null): number {
  if (COMPARISON_KEYS.has(key)) return 0
  if (!analysis) return 0
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

function fileCellStyle(key: string, rowMeta: CompareMeta, referenceMeta: CompareMeta | null): React.CSSProperties | undefined {
  const mismatch = mismatchIntensity(key, rowMeta, referenceMeta)
  if (COMPARISON_KEYS.has(key)) {
    if (mismatch > 0) return { backgroundColor: `rgba(244,63,94,${0.08 + mismatch * 0.55})` }
    return undefined
  }
  return undefined
}

function metricBar(key: string, analysis: AudioAnalysis | null): { width: string; className: string } | null {
  if (!analysis || COMPARISON_KEYS.has(key)) return null
  const intensity = ISSUE_KEYS.has(key) ? issueIntensity(key, analysis) : qualityIntensity(key, analysis)
  if (intensity <= 0) return null
  return {
    width: `${Math.round(intensity * 100)}%`,
    className: ISSUE_KEYS.has(key) ? 'bg-rose-500/75' : 'bg-emerald-500/75'
  }
}

function MetricValueCell({ value, bar }: { value: string; bar: { width: string; className: string } | null }): React.JSX.Element {
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

function OverviewTable({
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
  const discogsMeta = selectedCandidate ? {
    artist: selectedCandidate.match.artist,
    title: withVersion(selectedCandidate.match.title, selectedCandidate.match.version),
    year: selectedCandidate.match.year ?? '—',
    len: selectedCandidate.match.durationSeconds ?? null
  } : null
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

function TagField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-xs text-zinc-100 outline-none transition focus:border-amber-700/60"
      />
    </label>
  )
}

function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{children}</div>
}

export function ImportReviewDialog({
  filename,
  onClose,
  onCommitted
}: {
  filename: string | null
  onClose: () => void
  onCommitted: (result: ImportFileResult) => Promise<void> | void
}): React.JSX.Element | null {
  const [review, setReview] = useState<ImportReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [selectedExistingFilename, setSelectedExistingFilename] = useState<string | null>(null)
  const [comparison, setComparison] = useState<ImportComparison | null>(null)
  const [commitLoading, setCommitLoading] = useState<'import' | 'replace' | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showImportTools, setShowImportTools] = useState(false)
  const [tagDraft, setTagDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT)
  const [searchDraft, setSearchDraft] = useState<SearchDraft>({ artist: '', title: '', version: '' })
  const [crossfade, setCrossfade] = useState(0)
  const [sourceTime, setSourceTime] = useState(0)
  const [existingTime, setExistingTime] = useState(0)
  const [sourceDuration, setSourceDuration] = useState(0)
  const [existingDuration, setExistingDuration] = useState(0)
  const [linkPlayers, setLinkPlayers] = useState(true)
  const [playMode, setPlayMode] = useState<PlayMode>('stopped')

  const sourceAudioRef = useRef<HTMLAudioElement>(null)
  const existingAudioRef = useRef<HTMLAudioElement>(null)
  const reviewRequestRef = useRef(0)
  const compareRequestRef = useRef(0)
  const dirtyTagRef = useRef<Partial<Record<keyof TagDraft, boolean>>>({})

  const loadReview = (nextFilename: string, search?: Partial<ImportReviewSearch>, options: LoadReviewOptions = {}): Promise<void> => {
    const { preserveTagDraft = true, force = false } = options
    const requestId = ++reviewRequestRef.current
    const currentCandidate = review && selectedIndex !== null ? review.candidates[selectedIndex] ?? null : null
    const currentCandidateKey = candidateKey(currentCandidate)
    const currentExistingFilename = selectedExistingFilename
    compareRequestRef.current += 1
    if (!preserveTagDraft) dirtyTagRef.current = {}
    setLoading(true)
    setErrorMessage(null)
    setComparison(null)
    setConfirmReplace(false)
    setConfirmDelete(false)
    setShowImportTools(false)
    setPlayMode('stopped')
    setCrossfade(0)
    setSourceTime(0)
    setExistingTime(0)
    setSourceDuration(0)
    setExistingDuration(0)
    setLinkPlayers(true)
    return api.collection.getImportReview(nextFilename, search, force).then((nextReview) => {
      if (requestId !== reviewRequestRef.current) return
      const nextSelectedIndex = pickSelectedCandidateIndex(nextReview, currentCandidateKey)
      const nextCandidate = nextSelectedIndex === null ? null : nextReview.candidates[nextSelectedIndex] ?? null
      const nextExistingFilename = pickExistingFilename(nextReview, nextCandidate, currentExistingFilename)
      setReview(nextReview)
      setSearchDraft(toSearchDraft(nextReview.search))
      setSelectedIndex(nextSelectedIndex)
      setSelectedExistingFilename(nextExistingFilename)
      setTagDraft((current) => preserveTagDraft ? mergeTagDraft(current, toTagDraft(nextCandidate?.proposedTags), dirtyTagRef.current) : toTagDraft(nextCandidate?.proposedTags))
      setShowImportTools(nextReview.similarItems.length === 0)
      if (nextExistingFilename) void loadComparison(nextFilename, nextExistingFilename, false)
    }).catch((error) => {
      if (requestId !== reviewRequestRef.current) return
      setErrorMessage(formatError(error))
    }).finally(() => {
      if (requestId !== reviewRequestRef.current) return
      setLoading(false)
    })
  }

  const loadInitialReview = useEffectEvent((nextFilename: string): void => {
    void loadReview(nextFilename, undefined, { preserveTagDraft: false })
  })

  useEffect(() => {
    if (!filename) return
    loadInitialReview(filename)
    return () => {
      reviewRequestRef.current += 1
      compareRequestRef.current += 1
    }
  }, [filename])

  const selectedCandidate = useMemo(
    () => (review && selectedIndex !== null ? review.candidates[selectedIndex] ?? null : null),
    [review, selectedIndex]
  )

  const sourceUrl = filename ? localFileUrl('', filename) : ''
  const existingUrl = comparison ? localFileUrl('', comparison.existingFilename) : ''
  const selectedCompareItem = review?.similarItems.find((item) => item.filename === selectedExistingFilename) ?? null
  const destinationPreview = selectedCandidate
    ? buildDestinationPreview(filename ?? '', selectedCandidate.destinationRelativePath, selectedCandidate.match.version, tagDraft)
    : null
  const canCommit = Boolean(selectedCandidate && tagDraft.artist.trim() && tagDraft.title.trim())
  const hasLocalMatches = (review?.similarItems.length ?? 0) > 0
  const showImportAction = !hasLocalMatches || showImportTools
  const sourcePlaying = playMode === 'source' || playMode === 'both'
  const existingPlaying = playMode === 'existing' || playMode === 'both'
  const localColumns: DataTableColumn<CollectionItem>[] = [
    { key: 'path', header: 'Path', cellClassName: 'max-w-[260px] truncate text-zinc-200', render: (row) => <span title={row.filename}>{row.filename}</span> },
    { key: 'len', header: 'Len', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => formatCompactDuration(row.duration) },
    { key: 'score', header: 'Score', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => row.score?.toFixed(0) ?? '—' }
  ]
  const discogsColumns: DataTableColumn<ImportReview['candidates'][number]>[] = [
    {
      key: 'match',
      header: 'Match',
      cellClassName: 'max-w-[280px] truncate text-zinc-200',
      render: (row) => <span title={`${row.match.artist} - ${row.match.title}`}>{row.match.artist} - {row.match.title}{row.match.version ? ` (${row.match.version})` : ''}</span>
    },
    { key: 'len', header: 'Len', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => formatCompactDuration(row.match.durationSeconds) },
    { key: 'type', header: 'Type', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => summarizeMediaType(row.match.format) },
    { key: 'score', header: 'Score', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => row.match.score.toFixed(0) },
    { key: 'flags', header: '', cellClassName: 'w-[1%]', render: (row) => row.exactExistingFilename ? <Pill className="border-violet-700/50 bg-violet-950/30 text-violet-100">existing</Pill> : null }
  ]

  useEffect(() => {
    const source = sourceAudioRef.current
    const existing = existingAudioRef.current
    if (!source) return
    source.volume = comparison ? (100 - crossfade) / 100 : 1
    if (existing) existing.volume = comparison ? crossfade / 100 : 0
  }, [comparison, crossfade])

  useEffect(() => {
    const sourceAudio = sourceAudioRef.current
    const existingAudio = existingAudioRef.current
    return () => {
      sourceAudio?.pause()
      existingAudio?.pause()
    }
  }, [])

  if (!filename) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <SectionLabel>Import</SectionLabel>
        <div className="mt-1 text-sm text-zinc-300">Missing file selection.</div>
        <ActionButton size="xs" onClick={onClose}>Back To Import</ActionButton>
      </div>
    )
  }

  const syncSourceTime = (time: number): void => {
    if (sourceAudioRef.current) sourceAudioRef.current.currentTime = time
    setSourceTime(time)
    if (linkPlayers && existingAudioRef.current) {
      existingAudioRef.current.currentTime = time
      setExistingTime(time)
    }
  }

  const syncExistingTime = (time: number): void => {
    if (existingAudioRef.current) existingAudioRef.current.currentTime = time
    setExistingTime(time)
    if (linkPlayers && sourceAudioRef.current) {
      sourceAudioRef.current.currentTime = time
      setSourceTime(time)
    }
  }

  const pausePlayback = (): void => {
    sourceAudioRef.current?.pause()
    existingAudioRef.current?.pause()
    setPlayMode('stopped')
  }

  const updateTagField = (key: keyof TagDraft, value: string): void => {
    dirtyTagRef.current[key] = true
    setTagDraft((current) => ({ ...current, [key]: value }))
  }

  const playSource = (): void => {
    const source = sourceAudioRef.current
    if (!source) return
    source.currentTime = sourceTime
    void source.play().catch(() => {})
    if (linkPlayers && existingAudioRef.current) {
      existingAudioRef.current.currentTime = source.currentTime
      void existingAudioRef.current.play().catch(() => {})
      setPlayMode('both')
      return
    }
    existingAudioRef.current?.pause()
    setPlayMode('source')
  }

  const playExisting = (): void => {
    const existing = existingAudioRef.current
    if (!existing) return
    existing.currentTime = existingTime
    void existing.play().catch(() => {})
    if (linkPlayers && sourceAudioRef.current) {
      sourceAudioRef.current.currentTime = existing.currentTime
      void sourceAudioRef.current.play().catch(() => {})
      setPlayMode('both')
      return
    }
    sourceAudioRef.current?.pause()
    setPlayMode('existing')
  }

  async function loadComparison(currentFilename: string, existingFilename: string, resetTime: boolean = true): Promise<void> {
    const requestId = ++compareRequestRef.current
    pausePlayback()
    try {
      const nextComparison = await api.collection.compareImport(currentFilename, existingFilename)
      if (requestId !== compareRequestRef.current) return
      setComparison(nextComparison)
      setErrorMessage(null)
      if (resetTime) {
        setSourceTime(0)
        setExistingTime(0)
      }
    } catch (error) {
      if (requestId !== compareRequestRef.current) return
      setErrorMessage(formatError(error))
    }
  }

  const selectExisting = (existingFilename: string, resetTime: boolean = true): void => {
    if (!filename) return
    setSelectedExistingFilename(existingFilename)
    setConfirmReplace(false)
    void loadComparison(filename, existingFilename, resetTime)
  }

  const selectCandidate = (index: number): void => {
    if (!review) return
    const nextCandidate = review.candidates[index] ?? null
    const nextExistingFilename = pickExistingFilename(review, nextCandidate, selectedExistingFilename)
    setSelectedIndex(index)
    setConfirmReplace(false)
    setTagDraft((current) => mergeTagDraft(current, toTagDraft(nextCandidate?.proposedTags), dirtyTagRef.current))
    if (!nextExistingFilename) {
      compareRequestRef.current += 1
      setSelectedExistingFilename(null)
      setComparison(null)
      return
    }
    selectExisting(nextExistingFilename, false)
  }

  const handleCommit = async (mode: 'import' | 'replace'): Promise<void> => {
    if (!selectedCandidate || !canCommit) return
    if (mode === 'replace' && !selectedExistingFilename) return
    setCommitLoading(mode)
    try {
      const result = await api.collection.commitImport({
        filename,
        match: selectedCandidate.match,
        tags: toTagPreview(tagDraft),
        mode: mode === 'replace' ? 'replace_existing' : 'import_new',
        replaceFilename: selectedExistingFilename
      })
      await onCommitted(result)
      onClose()
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setCommitLoading(null)
      setConfirmReplace(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    setDeleteLoading(true)
    try {
      pausePlayback()
      await api.collection.deleteFile(filename)
      onClose()
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setDeleteLoading(false)
      setConfirmDelete(false)
    }
  }

  const handleRefine = async (): Promise<void> => {
    if (!filename) return
    await loadReview(filename, toSearchInput(searchDraft))
  }

  const handleRefresh = async (): Promise<void> => {
    if (!filename) return
    await loadReview(filename, undefined, { force: true })
  }

  return (
    <div className="space-y-3">
      <div className="relative rounded-2xl border border-zinc-800 bg-zinc-950">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">{filename}</div>
            {review?.parsed ? (
              <div className="text-[10px] text-zinc-500">
                {(review.parsed.artist ? `${review.parsed.artist} - ` : '') + review.parsed.title}
                {review.parsed.version ? ` (${review.parsed.version})` : ''}
              </div>
            ) : null}
          </div>
          <ActionButton size="xs" onClick={onClose}>Back To Import</ActionButton>
        </div>

        <div className="px-3 py-2.5">
          {loading ? (
            <Notice>Loading import review…</Notice>
          ) : errorMessage ? (
            <Notice tone="error">{errorMessage}</Notice>
          ) : review ? (
            <div className="space-y-3">
              {selectedExistingFilename ? (
                <Notice tone={confirmReplace ? 'warning' : 'default'}>
                  Replace target: {selectedExistingFilename}
                </Notice>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2 border-b border-zinc-800 pb-2">
                <ActionButton size="xs" disabled={loading || deleteLoading || commitLoading !== null} onClick={() => { void handleRefresh() }}>
                  Refresh
                </ActionButton>
                <ActionButton
                  size="xs"
                  tone="default"
                  className="border-rose-700/50 bg-rose-950/20 text-rose-100 hover:bg-rose-950/40"
                  disabled={deleteLoading || commitLoading !== null}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete File
                </ActionButton>
                {hasLocalMatches && !showImportTools ? (
                  <ActionButton size="xs" disabled={deleteLoading || commitLoading !== null} onClick={() => setShowImportTools(true)}>
                    Tag + Import
                  </ActionButton>
                ) : null}
                {showImportAction ? (
                  <ActionButton
                    size="xs"
                    tone="primary"
                    disabled={!canCommit || commitLoading !== null || deleteLoading}
                    onClick={() => {
                      void handleCommit('import')
                    }}
                  >
                    {commitLoading === 'import' ? 'Importing…' : hasLocalMatches ? 'Import New Anyway' : 'Import New'}
                  </ActionButton>
                ) : null}
                {confirmReplace ? (
                  <>
                    <ActionButton size="xs" disabled={commitLoading !== null} onClick={() => setConfirmReplace(false)}>Cancel</ActionButton>
                    <ActionButton
                      size="xs"
                      tone="danger"
                      disabled={!canCommit || !selectedExistingFilename || commitLoading !== null || deleteLoading}
                      onClick={() => {
                        void handleCommit('replace')
                      }}
                    >
                      {commitLoading === 'replace' ? 'Replacing…' : 'Confirm Replace'}
                    </ActionButton>
                  </>
                ) : (
                  <ActionButton
                    size="xs"
                    tone="danger"
                    disabled={!canCommit || !selectedExistingFilename || commitLoading !== null || deleteLoading}
                    onClick={() => setConfirmReplace(true)}
                  >
                    Replace Existing
                  </ActionButton>
                )}
              </div>
              <div className="grid gap-2 border-b border-zinc-800 pb-2 md:grid-cols-[1fr,140px,1fr]">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">New</div>
                    <div className="text-[10px] text-zinc-500">{formatCompactDuration(sourceTime)} / {formatCompactDuration(sourceDuration || review.sourceAnalysis?.durationSeconds || null)}</div>
                  </div>
                  <ActionButton
                    size="xs"
                    tone={sourcePlaying ? 'primary' : 'default'}
                    onClick={sourcePlaying ? pausePlayback : playSource}
                    aria-label={sourcePlaying ? 'Pause new' : 'Play new'}
                  >
                    {sourcePlaying ? <PauseIcon /> : <PlayIcon />}
                  </ActionButton>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(sourceDuration || review.sourceAnalysis?.durationSeconds || 0, 0)}
                    step={0.1}
                    value={Math.min(sourceTime, Math.max(sourceDuration || review.sourceAnalysis?.durationSeconds || 0, 0))}
                    onChange={(event) => syncSourceTime(Number(event.target.value))}
                    className="w-full"
                  />
                </div>
                <div className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-zinc-800/70 px-2 py-1">
                  <ActionButton size="xs" tone={linkPlayers ? 'primary' : 'default'} disabled={!comparison} onClick={() => setLinkPlayers((value) => !value)} aria-label={linkPlayers ? 'Unlink players' : 'Link players'}>
                    {linkPlayers ? <Link1Icon /> : <LinkBreak2Icon />}
                  </ActionButton>
                  <div className="flex w-full items-center gap-1 text-[9px] text-zinc-500">
                    <span>N</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={crossfade}
                      disabled={!comparison}
                      onChange={(event) => setCrossfade(Number(event.target.value))}
                      className="w-full"
                    />
                    <span>E</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Existing</div>
                    <div className="text-[10px] text-zinc-500">{formatCompactDuration(existingTime)} / {formatCompactDuration(existingDuration || comparison?.existingAnalysis?.durationSeconds || null)}</div>
                  </div>
                  <ActionButton
                    size="xs"
                    tone={existingPlaying ? 'primary' : 'default'}
                    disabled={!comparison}
                    onClick={existingPlaying ? pausePlayback : playExisting}
                    aria-label={existingPlaying ? 'Pause existing' : 'Play existing'}
                  >
                    {existingPlaying ? <PauseIcon /> : <PlayIcon />}
                  </ActionButton>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(existingDuration || comparison?.existingAnalysis?.durationSeconds || 0, 0)}
                    step={0.1}
                    value={Math.min(existingTime, Math.max(existingDuration || comparison?.existingAnalysis?.durationSeconds || 0, 0))}
                    onChange={(event) => syncExistingTime(Number(event.target.value))}
                    disabled={!comparison}
                    className="w-full"
                  />
                </div>
              </div>
              <OverviewTable
                filename={filename}
                parsed={review.parsed}
                sourceAnalysis={comparison?.sourceAnalysis ?? review.sourceAnalysis}
                selectedCandidate={selectedCandidate}
                selectedItem={selectedCompareItem}
                existingAnalysis={comparison?.existingAnalysis ?? null}
              />
              <form
                className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleRefine()
                }}
              >
                <input
                  value={searchDraft.artist}
                  onChange={(event) => setSearchDraft((value) => ({ ...value, artist: event.target.value }))}
                  placeholder="Artist"
                  className="min-w-[140px] flex-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-700/60"
                />
                <input
                  value={searchDraft.title}
                  onChange={(event) => setSearchDraft((value) => ({ ...value, title: event.target.value }))}
                  placeholder="Title"
                  className="min-w-[180px] flex-[1.2] rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-700/60"
                />
                <input
                  value={searchDraft.version}
                  onChange={(event) => setSearchDraft((value) => ({ ...value, version: event.target.value }))}
                  placeholder="Version"
                  className="min-w-[120px] flex-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-700/60"
                />
                <ActionButton size="xs" type="submit" disabled={loading}>Refine</ActionButton>
                <ActionButton
                  size="xs"
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    if (!filename || !review?.parsed) return
                    void loadReview(filename, review.parsed)
                  }}
                >
                  Reset
                </ActionButton>
              </form>
              <div className="grid gap-3 xl:grid-cols-[0.9fr,1fr]">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <SectionLabel>Local Matches</SectionLabel>
                    <div className="max-h-40 overflow-auto pr-1">
                      {review.similarItems.length === 0 ? (
                        <Notice>No similar tracks found in the collection.</Notice>
                      ) : (
                        <DataTable
                          columns={localColumns}
                          rows={review.similarItems}
                          getRowKey={(row) => row.filename}
                          onRowClick={(row) => selectExisting(row.filename)}
                          rowClassName={(row) => selectedExistingFilename === row.filename ? 'bg-zinc-800/30' : ''}
                          className="rounded-md"
                          tableClassName="min-w-[420px]"
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <SectionLabel>Discogs Matches</SectionLabel>
                    {destinationPreview ? <div className="truncate text-[10px] text-zinc-500">{destinationPreview}</div> : null}
                    <div className="max-h-40 overflow-auto pr-1">
                      {review.candidates.length === 0 ? (
                        <Notice tone="warning">No Discogs candidates available.</Notice>
                      ) : (
                        <DataTable
                          columns={discogsColumns}
                          rows={review.candidates}
                          getRowKey={(row, index) => `${row.match.releaseId}:${row.match.trackPosition ?? index}`}
                          onRowClick={(_, index) => selectCandidate(index)}
                          rowClassName={(_, index) => selectedIndex === index ? 'bg-amber-950/20' : ''}
                          className="rounded-md"
                          tableClassName="min-w-[540px]"
                        />
                      )}
                    </div>

                    {!selectedCandidate ? (
                      <Notice tone="warning">No Discogs candidate available for this file.</Notice>
                    ) : (
                      <div className="grid gap-2 md:grid-cols-2">
                        <TagField label="Artist" value={tagDraft.artist} onChange={(value) => updateTagField('artist', value)} />
                        <TagField label="Title" value={tagDraft.title} onChange={(value) => updateTagField('title', value)} />
                        <TagField label="Album" value={tagDraft.album} onChange={(value) => updateTagField('album', value)} />
                        <TagField label="Year" value={tagDraft.year} onChange={(value) => updateTagField('year', value)} />
                        <TagField label="Label" value={tagDraft.label} onChange={(value) => updateTagField('label', value)} />
                        <TagField label="Catalog #" value={tagDraft.catalogNumber} onChange={(value) => updateTagField('catalogNumber', value)} />
                        <TagField label="Track #" value={tagDraft.trackPosition} onChange={(value) => updateTagField('trackPosition', value)} />
                        <TagField label="Discogs Release" value={tagDraft.discogsReleaseId} onChange={(value) => updateTagField('discogsReleaseId', value)} />
                        <TagField label="Discogs Track" value={tagDraft.discogsTrackPosition} onChange={(value) => updateTagField('discogsTrackPosition', value)} />
                      </div>
                    )}
                    {!review.tagWriteSupported ? <Notice tone="warning">This format is not tag-writable yet. Import/replacement still works, but tag writing is skipped.</Notice> : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        {confirmDelete ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-4">
            <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
              <div className="text-sm font-semibold text-zinc-100">Delete File?</div>
              <div className="mt-2 text-xs text-zinc-400">
                Delete this download file from the import inbox. This does not touch the existing collection file.
              </div>
              <div className="mt-2 truncate text-[11px] text-zinc-500">{filename}</div>
              <div className="mt-4 flex justify-end gap-2">
                <ActionButton size="xs" disabled={deleteLoading} onClick={() => setConfirmDelete(false)}>Cancel</ActionButton>
                <ActionButton
                  size="xs"
                  tone="default"
                  className="border-rose-700/50 bg-rose-950/40 text-rose-100 hover:bg-rose-950/60"
                  disabled={deleteLoading}
                  onClick={() => {
                    void handleDelete()
                  }}
                >
                  {deleteLoading ? 'Deleting…' : 'Delete'}
                </ActionButton>
              </div>
            </div>
          </div>
        ) : null}

        <audio
          ref={sourceAudioRef}
          src={sourceUrl}
          preload="metadata"
          onLoadedMetadata={() => {
            const nextDuration = sourceAudioRef.current?.duration ?? 0
            setSourceDuration(isFinite(nextDuration) ? nextDuration : 0)
          }}
          onTimeUpdate={() => {
            if (!sourceAudioRef.current) return
            setSourceTime(sourceAudioRef.current.currentTime)
            if (linkPlayers && playMode === 'both' && existingAudioRef.current && Math.abs(existingAudioRef.current.currentTime - sourceAudioRef.current.currentTime) > 0.12) {
              existingAudioRef.current.currentTime = sourceAudioRef.current.currentTime
              setExistingTime(sourceAudioRef.current.currentTime)
            }
          }}
          onEnded={pausePlayback}
        />
        {comparison ? (
          <audio
            ref={existingAudioRef}
            src={existingUrl}
            preload="metadata"
            onLoadedMetadata={() => {
              const nextDuration = existingAudioRef.current?.duration ?? 0
              setExistingDuration(isFinite(nextDuration) ? nextDuration : 0)
            }}
            onTimeUpdate={() => {
              if (!existingAudioRef.current) return
              setExistingTime(existingAudioRef.current.currentTime)
              if (linkPlayers && playMode === 'both' && sourceAudioRef.current && Math.abs(sourceAudioRef.current.currentTime - existingAudioRef.current.currentTime) > 0.12) {
                sourceAudioRef.current.currentTime = existingAudioRef.current.currentTime
                setSourceTime(existingAudioRef.current.currentTime)
              }
            }}
            onEnded={pausePlayback}
          />
        ) : null}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AudioAnalysis,
  ImportComparison,
  ImportFileResult,
  ImportReview,
  ImportTagPreview
} from '../../../shared/api'
import { localFileUrl } from '../context/PlayerContext'
import { deriveTrackSummaryFromFilename, formatCompactDuration, formatFileSize } from '../lib/music-file'
import { ActionButton, Notice, Pill, ViewPanel, ViewSection } from './view'

type TagDraft = Record<keyof ImportTagPreview, string>
type PlayMode = 'stopped' | 'source' | 'existing' | 'both'
type MetricPreference = 'higher' | 'lower' | 'neutral' | 'tone'

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

const FORMAT_RANK: Record<string, number> = {
  wav: 5,
  aiff: 5,
  aif: 5,
  flac: 5,
  alac: 5,
  m4a: 3,
  aac: 3,
  ogg: 3,
  opus: 3,
  mp3: 2
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected import review error'
}

function formatDb(value: number | null, digits: number = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)} dB`
}

function formatLufs(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} LUFS`
}

function formatLu(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} LU`
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${value} kbps`
}

function formatHz(value: number | null): string {
  return value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value} Hz`
}

function formatBits(value: number | null): string {
  return value === null ? '—' : `${value}-bit`
}

function formatChannels(value: number | null): string {
  return value === null ? '—' : value === 1 ? 'Mono' : value === 2 ? 'Stereo' : `${value} ch`
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

function comparisonNotes(source: AudioAnalysis | null, existing: AudioAnalysis | null): string[] {
  if (!source || !existing) return []
  const notes: string[] = []
  if ((source.bitrateKbps ?? 0) > (existing.bitrateKbps ?? 0)) notes.push('Higher encoded bitrate on the new file.')
  if ((source.sampleRateHz ?? 0) > (existing.sampleRateHz ?? 0)) notes.push('Higher sample rate on the new file.')
  if ((source.loudnessRangeLu ?? 0) - (existing.loudnessRangeLu ?? 0) >= 1.5) notes.push('New file keeps more dynamic range.')
  if (source.noiseFloorDb !== null && existing.noiseFloorDb !== null && source.noiseFloorDb < existing.noiseFloorDb - 3) {
    notes.push('New file measures cleaner on noise floor.')
  }
  if (source.highBandRmsDb !== null && existing.highBandRmsDb !== null && Math.abs(source.highBandRmsDb - existing.highBandRmsDb) >= 2) {
    notes.push(source.highBandRmsDb > existing.highBandRmsDb ? 'New file is brighter in the highs.' : 'Existing file is brighter in the highs.')
  }
  if (source.lowBandRmsDb !== null && existing.lowBandRmsDb !== null && Math.abs(source.lowBandRmsDb - existing.lowBandRmsDb) >= 2) {
    notes.push(source.lowBandRmsDb > existing.lowBandRmsDb ? 'New file carries more bass energy.' : 'Existing file carries more bass energy.')
  }
  return notes
}

function metricCellTone(
  label: string,
  preference: MetricPreference,
  source: number | null,
  existing: number | null,
  side: 'source' | 'existing'
): { badge: string | null; className: string } {
  if (source === null || existing === null || source === existing || preference === 'neutral') {
    return { badge: null, className: 'bg-zinc-950/60 text-zinc-200 ring-1 ring-inset ring-zinc-800/80' }
  }
  if (preference === 'tone') {
    const sourceLeads = source > existing
    const leads = side === 'source' ? sourceLeads : !sourceLeads
    if (label === 'Highs') {
      return leads
        ? { badge: 'Brighter', className: 'bg-violet-950/70 text-violet-100 ring-1 ring-inset ring-violet-700/60' }
        : { badge: 'Softer', className: 'bg-amber-950/70 text-amber-100 ring-1 ring-inset ring-amber-700/60' }
    }
    return leads
      ? { badge: 'Heavier', className: 'bg-cyan-950/70 text-cyan-100 ring-1 ring-inset ring-cyan-700/60' }
      : { badge: 'Leaner', className: 'bg-amber-950/70 text-amber-100 ring-1 ring-inset ring-amber-700/60' }
  }
  const sourceBetter = preference === 'higher' ? source > existing : source < existing
  const better = side === 'source' ? sourceBetter : !sourceBetter
  return better
    ? { badge: label === 'Noise' ? 'Cleaner' : 'Wins', className: 'bg-sky-950/80 text-sky-100 ring-1 ring-inset ring-sky-700/60' }
    : { badge: label === 'Noise' ? 'Noisier' : null, className: 'bg-zinc-900/90 text-zinc-300 ring-1 ring-inset ring-zinc-700/80' }
}

function CompactMetric({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail?: string
}): React.JSX.Element {
  return (
    <ViewPanel tone="muted" padding="sm" className="space-y-0.5">
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-sm font-semibold text-zinc-100">{value}</div>
      {detail ? <div className="text-[10px] text-zinc-500">{detail}</div> : null}
    </ViewPanel>
  )
}

function AnalysisGrid({ analysis }: { analysis: AudioAnalysis | null }): React.JSX.Element {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-5">
      <CompactMetric label="Format" value={analysis ? analysis.format.toUpperCase() : '—'} detail={analysis?.codec ?? '—'} />
      <CompactMetric label="Bitrate" value={formatRate(analysis?.bitrateKbps ?? null)} detail={formatBits(analysis?.bitDepth ?? null)} />
      <CompactMetric label="Sample Rate" value={formatHz(analysis?.sampleRateHz ?? null)} detail={formatChannels(analysis?.channels ?? null)} />
      <CompactMetric label="Duration" value={formatCompactDuration(analysis?.durationSeconds ?? null)} detail={analysis ? formatFileSize(analysis.fileSizeBytes) : '—'} />
      <CompactMetric label="Loudness" value={formatLufs(analysis?.integratedLufs ?? null)} detail={`Peak ${formatDb(analysis?.truePeakDbfs ?? null)}`} />
      <CompactMetric label="Dynamics" value={formatLu(analysis?.loudnessRangeLu ?? null)} detail={`Crest ${formatDb(analysis?.crestDb ?? null)}`} />
      <CompactMetric label="RMS" value={formatDb(analysis?.rmsLevelDb ?? null)} detail={`Peak ${formatDb(analysis?.peakLevelDb ?? null)}`} />
      <CompactMetric label="Noise" value={formatDb(analysis?.noiseFloorDb ?? null)} detail="Lower is cleaner" />
      <CompactMetric label="Lows" value={formatDb(analysis?.lowBandRmsDb ?? null)} detail="RMS < 160 Hz" />
      <CompactMetric label="Highs" value={formatDb(analysis?.highBandRmsDb ?? null)} detail="RMS > 4 kHz" />
    </div>
  )
}

function ComparisonTable({
  source,
  existing
}: {
  source: AudioAnalysis | null
  existing: AudioAnalysis | null
}): React.JSX.Element {
  const metrics = [
    {
      label: 'Format',
      preference: 'higher' as const,
      sourceValue: source ? (FORMAT_RANK[source.format] ?? 0) : null,
      existingValue: existing ? (FORMAT_RANK[existing.format] ?? 0) : null,
      sourceText: source ? `${source.format.toUpperCase()} / ${source.codec ?? '—'}` : '—',
      existingText: existing ? `${existing.format.toUpperCase()} / ${existing.codec ?? '—'}` : '—'
    },
    { label: 'Bitrate', preference: 'higher' as const, sourceValue: source?.bitrateKbps ?? null, existingValue: existing?.bitrateKbps ?? null, sourceText: formatRate(source?.bitrateKbps ?? null), existingText: formatRate(existing?.bitrateKbps ?? null) },
    { label: 'Bit depth', preference: 'higher' as const, sourceValue: source?.bitDepth ?? null, existingValue: existing?.bitDepth ?? null, sourceText: formatBits(source?.bitDepth ?? null), existingText: formatBits(existing?.bitDepth ?? null) },
    { label: 'Sample rate', preference: 'higher' as const, sourceValue: source?.sampleRateHz ?? null, existingValue: existing?.sampleRateHz ?? null, sourceText: formatHz(source?.sampleRateHz ?? null), existingText: formatHz(existing?.sampleRateHz ?? null) },
    { label: 'LUFS', preference: 'neutral' as const, sourceValue: source?.integratedLufs ?? null, existingValue: existing?.integratedLufs ?? null, sourceText: formatLufs(source?.integratedLufs ?? null), existingText: formatLufs(existing?.integratedLufs ?? null) },
    { label: 'LRA', preference: 'higher' as const, sourceValue: source?.loudnessRangeLu ?? null, existingValue: existing?.loudnessRangeLu ?? null, sourceText: formatLu(source?.loudnessRangeLu ?? null), existingText: formatLu(existing?.loudnessRangeLu ?? null) },
    { label: 'Crest', preference: 'higher' as const, sourceValue: source?.crestDb ?? null, existingValue: existing?.crestDb ?? null, sourceText: formatDb(source?.crestDb ?? null), existingText: formatDb(existing?.crestDb ?? null) },
    { label: 'Noise', preference: 'lower' as const, sourceValue: source?.noiseFloorDb ?? null, existingValue: existing?.noiseFloorDb ?? null, sourceText: formatDb(source?.noiseFloorDb ?? null), existingText: formatDb(existing?.noiseFloorDb ?? null) },
    { label: 'Lows', preference: 'tone' as const, sourceValue: source?.lowBandRmsDb ?? null, existingValue: existing?.lowBandRmsDb ?? null, sourceText: formatDb(source?.lowBandRmsDb ?? null), existingText: formatDb(existing?.lowBandRmsDb ?? null) },
    { label: 'Highs', preference: 'tone' as const, sourceValue: source?.highBandRmsDb ?? null, existingValue: existing?.highBandRmsDb ?? null, sourceText: formatDb(source?.highBandRmsDb ?? null), existingText: formatDb(existing?.highBandRmsDb ?? null) }
  ]

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead>
          <tr className="bg-zinc-950/60 uppercase tracking-wide text-zinc-500">
            <th className="px-2 py-1 font-medium">Metric</th>
            <th className="px-2 py-1 font-medium">New</th>
            <th className="px-2 py-1 font-medium">Existing</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.label} className="border-t border-zinc-800">
              <td className="px-2 py-1.5 text-zinc-400">{metric.label}</td>
              {(['source', 'existing'] as const).map((side) => {
                const tone = metricCellTone(metric.label, metric.preference, metric.sourceValue, metric.existingValue, side)
                const text = side === 'source' ? metric.sourceText : metric.existingText
                return (
                  <td key={side} className="px-2 py-1.5">
                    <div className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 font-medium ${tone.className}`}>
                      <span>{text}</span>
                      {tone.badge ? <span className="rounded bg-black/20 px-1 py-0.5 text-[9px] uppercase tracking-wide">{tone.badge}</span> : null}
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
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
  const [replaceFilename, setReplaceFilename] = useState<string | null>(null)
  const [comparison, setComparison] = useState<ImportComparison | null>(null)
  const [compareLoading, setCompareLoading] = useState<string | null>(null)
  const [commitLoading, setCommitLoading] = useState<'import' | 'replace' | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tagDraft, setTagDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT)
  const [crossfade, setCrossfade] = useState(50)
  const [compareTime, setCompareTime] = useState(0)
  const [compareDuration, setCompareDuration] = useState(0)
  const [playMode, setPlayMode] = useState<PlayMode>('stopped')

  const sourceAudioRef = useRef<HTMLAudioElement>(null)
  const existingAudioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    if (!filename) return
    let cancelled = false
    setLoading(true)
    setErrorMessage(null)
    setComparison(null)
    setConfirmReplace(false)
    setConfirmDelete(false)
    setPlayMode('stopped')
    setCompareTime(0)
    setCompareDuration(0)
    window.api.collection.getImportReview(filename).then((nextReview) => {
      if (cancelled) return
      setReview(nextReview)
      setSelectedIndex(nextReview.selectedCandidateIndex)
      const nextCandidate =
        nextReview.selectedCandidateIndex === null ? null : nextReview.candidates[nextReview.selectedCandidateIndex] ?? null
      setReplaceFilename(nextCandidate?.exactExistingFilename ?? null)
      setTagDraft(toTagDraft(nextCandidate?.proposedTags))
    }).catch((error) => {
      if (!cancelled) setErrorMessage(formatError(error))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [filename])

  const selectedCandidate = useMemo(
    () => (review && selectedIndex !== null ? review.candidates[selectedIndex] ?? null : null),
    [review, selectedIndex]
  )

  const notes = comparisonNotes(comparison?.sourceAnalysis ?? null, comparison?.existingAnalysis ?? null)
  const sourceUrl = filename ? localFileUrl('', filename) : ''
  const existingUrl = comparison ? localFileUrl('', comparison.existingFilename) : ''
  const destinationPreview = selectedCandidate
    ? buildDestinationPreview(filename ?? '', selectedCandidate.destinationRelativePath, selectedCandidate.match.version, tagDraft)
    : null
  const canCommit = Boolean(selectedCandidate && tagDraft.artist.trim() && tagDraft.title.trim())

  useEffect(() => {
    setComparison(null)
    setConfirmReplace(false)
    setConfirmDelete(false)
    setReplaceFilename(selectedCandidate?.exactExistingFilename ?? null)
    setTagDraft(toTagDraft(selectedCandidate?.proposedTags))
  }, [selectedCandidate?.destinationRelativePath])

  useEffect(() => {
    const source = sourceAudioRef.current
    const existing = existingAudioRef.current
    if (!source) return
    source.volume = comparison ? (100 - crossfade) / 100 : 1
    if (existing) existing.volume = comparison ? crossfade / 100 : 0
  }, [comparison, crossfade])

  useEffect(() => {
    return () => {
      sourceAudioRef.current?.pause()
      existingAudioRef.current?.pause()
    }
  }, [])

  if (!filename) {
    return (
      <ViewSection title="Import Review" subtitle="Missing file selection." padding="sm">
        <ActionButton size="xs" onClick={onClose}>Back To Import</ActionButton>
      </ViewSection>
    )
  }

  const syncTimes = (time: number): void => {
    if (sourceAudioRef.current) sourceAudioRef.current.currentTime = time
    if (existingAudioRef.current) existingAudioRef.current.currentTime = time
    setCompareTime(time)
  }

  const pausePlayback = (): void => {
    sourceAudioRef.current?.pause()
    existingAudioRef.current?.pause()
    setPlayMode('stopped')
  }

  const playSource = (): void => {
    const source = sourceAudioRef.current
    if (!source) return
    existingAudioRef.current?.pause()
    source.currentTime = compareTime
    void source.play().catch(() => {})
    setPlayMode('source')
  }

  const playExisting = (): void => {
    const existing = existingAudioRef.current
    if (!existing) return
    sourceAudioRef.current?.pause()
    existing.currentTime = compareTime
    void existing.play().catch(() => {})
    setPlayMode('existing')
  }

  const playBoth = (): void => {
    const source = sourceAudioRef.current
    const existing = existingAudioRef.current
    if (!source || !existing) return
    source.currentTime = compareTime
    existing.currentTime = compareTime
    void source.play().catch(() => {})
    void existing.play().catch(() => {})
    setPlayMode('both')
  }

  const handleCompare = async (existingFilename: string): Promise<void> => {
    setCompareLoading(existingFilename)
    pausePlayback()
    try {
      setComparison(await window.api.collection.compareImport(filename, existingFilename))
      setErrorMessage(null)
      setCompareTime(0)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setCompareLoading(null)
    }
  }

  const handleCommit = async (mode: 'import' | 'replace'): Promise<void> => {
    if (!selectedCandidate || !canCommit) return
    if (mode === 'replace' && !replaceFilename) return
    setCommitLoading(mode)
    try {
      const result = await window.api.collection.commitImport({
        filename,
        match: selectedCandidate.match,
        tags: toTagPreview(tagDraft),
        mode: mode === 'replace' ? 'replace_existing' : 'import_new',
        replaceFilename
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
      await window.api.collection.deleteFile(filename)
      onClose()
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setDeleteLoading(false)
      setConfirmDelete(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-[0.2em] text-zinc-500">Import Review</div>
            <div className="mt-0.5 truncate text-sm font-semibold text-zinc-100">{filename}</div>
            {review?.parsed ? (
              <div className="text-[11px] text-zinc-500">
                {review.parsed.artist} - {review.parsed.title}
                {review.parsed.version ? ` (${review.parsed.version})` : ''}
              </div>
            ) : null}
          </div>
          <ActionButton size="xs" onClick={onClose}>Back To Import</ActionButton>
        </div>

        <div className="px-4 py-3">
          {loading ? (
            <Notice>Loading import review…</Notice>
          ) : errorMessage ? (
            <Notice tone="error">{errorMessage}</Notice>
          ) : review ? (
            <div className="grid gap-3 xl:grid-cols-[1.2fr,0.95fr]">
              <div className="space-y-3">
                <ViewSection
                  title="Tags"
                  subtitle={destinationPreview ? `Destination: ${destinationPreview}` : 'Pick a candidate to enable import.'}
                  padding="sm"
                >
                  {!selectedCandidate ? (
                    <Notice tone="warning">No Discogs candidate available for this file.</Notice>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      <TagField label="Artist" value={tagDraft.artist} onChange={(value) => setTagDraft((prev) => ({ ...prev, artist: value }))} />
                      <TagField label="Title" value={tagDraft.title} onChange={(value) => setTagDraft((prev) => ({ ...prev, title: value }))} />
                      <TagField label="Album" value={tagDraft.album} onChange={(value) => setTagDraft((prev) => ({ ...prev, album: value }))} />
                      <TagField label="Year" value={tagDraft.year} onChange={(value) => setTagDraft((prev) => ({ ...prev, year: value }))} />
                      <TagField label="Label" value={tagDraft.label} onChange={(value) => setTagDraft((prev) => ({ ...prev, label: value }))} />
                      <TagField label="Catalog #" value={tagDraft.catalogNumber} onChange={(value) => setTagDraft((prev) => ({ ...prev, catalogNumber: value }))} />
                      <TagField label="Track #" value={tagDraft.trackPosition} onChange={(value) => setTagDraft((prev) => ({ ...prev, trackPosition: value }))} />
                      <TagField label="Discogs Release" value={tagDraft.discogsReleaseId} onChange={(value) => setTagDraft((prev) => ({ ...prev, discogsReleaseId: value }))} />
                      <TagField label="Discogs Track" value={tagDraft.discogsTrackPosition} onChange={(value) => setTagDraft((prev) => ({ ...prev, discogsTrackPosition: value }))} />
                    </div>
                  )}
                  {!review.tagWriteSupported ? (
                    <Notice tone="warning" className="mt-2">
                      This format is not tag-writable yet. Import/replacement still works, but tag writing is skipped.
                    </Notice>
                  ) : null}
                </ViewSection>

                <ViewSection title="New File KPIs" subtitle="Compact but deeper than format/bitrate." padding="sm">
                  <AnalysisGrid analysis={review.sourceAnalysis} />
                </ViewSection>

                <ViewSection title="A/B Compare" subtitle="Filled cells and labels mark the leader. Violet/amber rows show tonal direction, not absolute quality." padding="sm">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionButton size="xs" tone={playMode === 'source' ? 'primary' : 'default'} onClick={playSource}>
                        Play New
                      </ActionButton>
                      <ActionButton
                        size="xs"
                        tone={playMode === 'existing' ? 'primary' : 'default'}
                        disabled={!comparison}
                        onClick={playExisting}
                      >
                        Play Existing
                      </ActionButton>
                      <ActionButton
                        size="xs"
                        tone={playMode === 'both' ? 'primary' : 'default'}
                        disabled={!comparison}
                        onClick={playBoth}
                      >
                        Sync A/B
                      </ActionButton>
                      <ActionButton size="xs" disabled={playMode === 'stopped'} onClick={pausePlayback}>
                        Pause
                      </ActionButton>
                      <div className="ml-auto text-[10px] text-zinc-500">
                        {formatCompactDuration(compareTime)} / {formatCompactDuration(compareDuration || review.sourceAnalysis?.durationSeconds || null)}
                      </div>
                    </div>

                    <div className="grid gap-2 md:grid-cols-[1fr,180px]">
                      <input
                        type="range"
                        min={0}
                        max={Math.max(compareDuration || review.sourceAnalysis?.durationSeconds || 0, 0)}
                        step={0.1}
                        value={Math.min(compareTime, Math.max(compareDuration || review.sourceAnalysis?.durationSeconds || 0, 0))}
                        onChange={(event) => syncTimes(Number(event.target.value))}
                        className="w-full"
                      />
                      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                        <span>New</span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={crossfade}
                          disabled={!comparison}
                          onChange={(event) => setCrossfade(Number(event.target.value))}
                          className="w-full"
                        />
                        <span>Existing</span>
                      </div>
                    </div>

                    {comparison ? (
                      <>
                        <ComparisonTable source={comparison.sourceAnalysis} existing={comparison.existingAnalysis} />
                        {notes.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {notes.map((note) => (
                              <Pill key={note} tone="primary">{note}</Pill>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <Notice>Pick a similar track and hit Compare to unlock A/B playback and the colored KPI table.</Notice>
                    )}
                  </div>
                </ViewSection>
              </div>

              <div className="space-y-3">
                <ViewSection title="Candidates" subtitle="Compact Discogs choices for the tags and destination." padding="sm">
                  <div className="space-y-1.5">
                    {review.candidates.length === 0 ? (
                      <Notice tone="warning">No Discogs candidates available.</Notice>
                    ) : (
                      review.candidates.map((candidate, index) => (
                        <button
                          key={`${candidate.match.releaseId}:${candidate.match.trackPosition ?? index}`}
                          type="button"
                          onClick={() => setSelectedIndex(index)}
                          className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${
                            selectedIndex === index
                              ? 'border-amber-700/60 bg-amber-950/20'
                              : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-zinc-100">
                                {candidate.match.artist} - {candidate.match.title}
                                {candidate.match.version ? ` (${candidate.match.version})` : ''}
                              </div>
                              <div className="truncate text-[10px] text-zinc-500">
                                {candidate.match.releaseTitle}
                                {candidate.match.year ? ` • ${candidate.match.year}` : ''}
                              </div>
                              <div className="truncate text-[10px] text-zinc-600">{candidate.destinationRelativePath}</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <Pill tone={selectedIndex === index ? 'primary' : 'muted'}>{candidate.match.score.toFixed(0)}</Pill>
                              {candidate.exactExistingFilename ? <div className="mt-1"><Pill className="border-violet-700/50 bg-violet-950/30 text-violet-100">existing</Pill></div> : null}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </ViewSection>

                <ViewSection title="Similar In Collection" subtitle="Compare first, then decide whether to keep both or replace." padding="sm">
                  <div className="space-y-1.5">
                    {review.similarItems.length === 0 ? (
                      <Notice>No similar tracks found in the collection.</Notice>
                    ) : (
                      review.similarItems.map((item) => {
                        const summary = deriveTrackSummaryFromFilename(item.filename)
                        const isReplaceTarget = replaceFilename === item.filename
                        const isCompared = comparison?.existingFilename === item.filename
                        return (
                          <ViewPanel key={item.filename} tone="muted" padding="sm" className="space-y-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-zinc-100">
                                  {summary.artist} - {summary.title}
                                </div>
                                <div className="truncate text-[10px] text-zinc-500">{item.filename}</div>
                              </div>
                              <div className="flex gap-1.5">
                                <ActionButton
                                  size="xs"
                                  tone={isCompared ? 'primary' : 'default'}
                                  disabled={compareLoading === item.filename}
                                  onClick={() => {
                                    void handleCompare(item.filename)
                                  }}
                                >
                                  {compareLoading === item.filename ? '…' : 'Compare'}
                                </ActionButton>
                                <ActionButton
                                  size="xs"
                                  tone="default"
                                  className={isReplaceTarget ? 'border-sky-700/50 bg-sky-950/30 text-sky-100 hover:bg-sky-950/50' : undefined}
                                  onClick={() => {
                                    setReplaceFilename(item.filename)
                                    setConfirmReplace(false)
                                  }}
                                >
                                  Replace
                                </ActionButton>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              <Pill>{formatFileSize(item.filesize)}</Pill>
                              {item.score !== null ? <Pill tone="primary">score {item.score.toFixed(0)}</Pill> : null}
                              {selectedCandidate?.exactExistingFilename === item.filename ? <Pill className="border-violet-700/50 bg-violet-950/30 text-violet-100">exact destination</Pill> : null}
                              {isReplaceTarget ? <Pill className="border-sky-700/50 bg-sky-950/30 text-sky-100">replace target</Pill> : null}
                            </div>
                          </ViewPanel>
                        )
                      })
                    )}
                  </div>
                </ViewSection>
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-zinc-800 px-4 py-3">
          {replaceFilename ? (
            <Notice tone={confirmReplace ? 'warning' : 'default'} className="mb-2">
              Replace target: {replaceFilename}
            </Notice>
          ) : null}
          {confirmDelete ? (
            <Notice tone="warning" className="mb-2">
              Delete this download file from the import inbox. This does not touch the existing collection file.
            </Notice>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] text-zinc-500">
              Compact review: edit tags, compare, then commit.
            </div>
            <div className="flex flex-wrap gap-2">
              {confirmDelete ? (
                <>
                  <ActionButton size="xs" disabled={deleteLoading || commitLoading !== null} onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </ActionButton>
                  <ActionButton
                    size="xs"
                    tone="default"
                    className="border-rose-700/50 bg-rose-950/40 text-rose-100 hover:bg-rose-950/60"
                    disabled={deleteLoading || commitLoading !== null}
                    onClick={() => {
                      void handleDelete()
                    }}
                  >
                    {deleteLoading ? 'Deleting…' : 'Confirm Delete'}
                  </ActionButton>
                </>
              ) : (
                <ActionButton
                  size="xs"
                  tone="default"
                  className="border-rose-700/50 bg-rose-950/20 text-rose-100 hover:bg-rose-950/40"
                  disabled={deleteLoading || commitLoading !== null}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete File
                </ActionButton>
              )}
              <ActionButton
                size="xs"
                tone="primary"
                disabled={!canCommit || commitLoading !== null || deleteLoading}
                onClick={() => {
                  void handleCommit('import')
                }}
              >
                {commitLoading === 'import' ? 'Importing…' : 'Import New'}
              </ActionButton>
              {confirmReplace ? (
                <>
                  <ActionButton size="xs" disabled={commitLoading !== null} onClick={() => setConfirmReplace(false)}>
                    Cancel
                  </ActionButton>
                  <ActionButton
                    size="xs"
                    tone="danger"
                    disabled={!canCommit || !replaceFilename || commitLoading !== null || deleteLoading}
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
                  disabled={!canCommit || !replaceFilename || commitLoading !== null || deleteLoading}
                  onClick={() => setConfirmReplace(true)}
                >
                  Replace Existing
                </ActionButton>
              )}
            </div>
          </div>
        </div>

        <audio
          ref={sourceAudioRef}
          src={sourceUrl}
          preload="metadata"
          onLoadedMetadata={() => {
            const sourceDuration = sourceAudioRef.current?.duration ?? 0
            const existingDuration = existingAudioRef.current?.duration ?? 0
            setCompareDuration(Math.max(isFinite(sourceDuration) ? sourceDuration : 0, isFinite(existingDuration) ? existingDuration : 0))
          }}
          onTimeUpdate={() => {
            if (!sourceAudioRef.current) return
            setCompareTime(sourceAudioRef.current.currentTime)
            if (playMode === 'both' && existingAudioRef.current && Math.abs(existingAudioRef.current.currentTime - sourceAudioRef.current.currentTime) > 0.12) {
              existingAudioRef.current.currentTime = sourceAudioRef.current.currentTime
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
              const sourceDuration = sourceAudioRef.current?.duration ?? 0
              const existingDuration = existingAudioRef.current?.duration ?? 0
              setCompareDuration(Math.max(isFinite(sourceDuration) ? sourceDuration : 0, isFinite(existingDuration) ? existingDuration : 0))
            }}
            onTimeUpdate={() => {
              if (playMode === 'existing' && existingAudioRef.current) setCompareTime(existingAudioRef.current.currentTime)
            }}
            onEnded={pausePlayback}
          />
        ) : null}
      </div>
    </div>
  )
}

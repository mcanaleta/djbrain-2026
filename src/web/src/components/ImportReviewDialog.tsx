import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type {
  CollectionItem,
  ImportComparison,
  ImportFileResult,
  ImportReview,
  ImportReviewSearch
} from '../../../shared/api'
import { api } from '../api/client'
import { localFileUrl } from '../context/PlayerContext'
import { getErrorMessage } from '../lib/error-utils'
import {
  EMPTY_TAG_DRAFT,
  buildDestinationPreview,
  candidateKey,
  formatFormat,
  formatQualityTitle,
  formatScore,
  guessMeta,
  guessYear,
  mergeTagDraft,
  pickExistingFilename,
  pickSelectedCandidateIndex,
  summarizeMediaType,
  toSearchDraft,
  toSearchInput,
  toTagDraft,
  toTagPreview,
  type ReviewCandidate,
  type SearchDraft,
  type TagDraft,
  withVersion
} from '../lib/importReview'
import { formatCompactDuration } from '../lib/music-file'
import { buildDiscogsReleaseUrl } from '../lib/urls'
import { useAudioCompare } from '../hooks/useAudioCompare'
import { AudioCompareControls } from './AudioCompareControls'
import { ImportReviewOverviewTable } from './ImportReviewOverviewTable'
import { ActionButton } from './view/ActionButton'
import { CompactInput } from './view/CompactInput'
import { DataTable, type DataTableColumn } from './view/DataTable'
import { MiniStat } from './view/MiniStat'
import { Notice } from './view/Notice'
import { Pill } from './view/Pill'
import { SectionKicker } from './view/SectionKicker'
import { SourceIconLink } from './view/SourceIconLink'

type LoadReviewOptions = { preserveTagDraft?: boolean; force?: boolean }

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected import review error')
}

export function ImportReviewDialog({
  filename,
  currentItem,
  queuePosition,
  queueTotal,
  onClose,
  onCommitted,
  onDeleted
}: {
  filename: string | null
  currentItem: CollectionItem | null
  queuePosition: number | null
  queueTotal: number | null
  onClose: () => void
  onCommitted: (result: ImportFileResult) => Promise<void> | void
  onDeleted: () => Promise<void> | void
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
  const [showAnalysis, setShowAnalysis] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tagDraft, setTagDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT)
  const [searchDraft, setSearchDraft] = useState<SearchDraft>({ artist: '', title: '', version: '' })
  const reviewRequestRef = useRef(0)
  const compareRequestRef = useRef(0)
  const dirtyTagRef = useRef<Partial<Record<keyof TagDraft, boolean>>>({})
  const sourceUrl = filename ? localFileUrl('', filename) : ''
  const existingUrl = comparison ? localFileUrl('', comparison.existingFilename) : ''
  const audio = useAudioCompare({
    sourceUrl,
    existingUrl,
    enabled: Boolean(comparison),
    resetKey: `${filename ?? ''}:${selectedExistingFilename ?? ''}:${comparison?.existingFilename ?? ''}`
  })

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
    setShowAnalysis(false)
    setShowAdvanced(false)
    audio.pausePlayback()
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

  const selectedCompareItem = review?.similarItems.find((item) => item.filename === selectedExistingFilename) ?? null
  const destinationPreview = selectedCandidate
    ? buildDestinationPreview(filename ?? '', selectedCandidate.destinationRelativePath, selectedCandidate.match.version, tagDraft)
    : null
  const canCommit = Boolean(selectedCandidate && tagDraft.artist.trim() && tagDraft.title.trim())
  const hasLocalMatches = (review?.similarItems.length ?? 0) > 0
  const showImportAction = !hasLocalMatches || showImportTools
  const sourceArtist = currentItem?.recordingCanonical?.artist ?? review?.parsed?.artist ?? guessMeta(filename ?? '').artist
  const sourceTitle = currentItem?.recordingCanonical?.title
    ? withVersion(currentItem.recordingCanonical.title, currentItem.recordingCanonical.version)
    : review?.parsed
      ? withVersion(review.parsed.title, review.parsed.version)
      : guessMeta(filename ?? '').title
  const sourceYear = currentItem?.recordingCanonical?.year ?? guessYear(filename ?? '')
  const sourceQualityScore = currentItem?.qualityScore ?? null
  const sourceQualityTitle = formatQualityTitle(sourceQualityScore, comparison?.sourceAnalysis ?? review?.sourceAnalysis)
  const selectedExistingQualityScore = selectedCompareItem?.qualityScore ?? currentItem?.importExistingQualityScore ?? null
  const selectedExistingQualityTitle = formatQualityTitle(selectedExistingQualityScore, comparison?.existingAnalysis ?? null)
  const selectedReleaseUrl = selectedCandidate ? buildDiscogsReleaseUrl(selectedCandidate.match.releaseId) : null
  const selectedReleaseLabel = selectedCandidate
    ? `${selectedCandidate.match.releaseTitle} · ${summarizeMediaType(selectedCandidate.match.format)}`
    : null
  const queueText = queuePosition && queueTotal ? `${queuePosition} / ${queueTotal}` : null
  const localColumns: DataTableColumn<CollectionItem>[] = [
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[140px] truncate text-zinc-200',
      render: (row) => row.recordingCanonical?.artist ?? row.importArtist ?? guessMeta(row.filename).artist
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[240px] truncate text-zinc-200',
      render: (row) => (
        <div>
          <div title={row.filename}>
            {row.recordingCanonical?.title
              ? withVersion(row.recordingCanonical.title, row.recordingCanonical.version)
              : row.importTitle
                ? withVersion(row.importTitle, row.importVersion)
                : guessMeta(row.filename).title}
          </div>
          <div className="truncate text-[10px] text-zinc-500">{row.filename}</div>
        </div>
      )
    },
    { key: 'year', header: 'Year', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => row.recordingCanonical?.year ?? row.importYear ?? guessYear(row.filename) },
    { key: 'len', header: 'Len', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => formatCompactDuration(row.duration) },
    {
      key: 'quality',
      header: 'Quality',
      cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400',
      render: (row) => <span title={formatQualityTitle(row.qualityScore ?? null, null)}>{formatScore(row.qualityScore)}</span>
    },
    { key: 'discogs', header: 'D', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => <SourceIconLink url={row.recordingDiscogsUrl} label="Discogs" /> },
    { key: 'mb', header: 'MB', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => <SourceIconLink url={row.recordingMusicBrainzUrl} label="MusicBrainz" /> }
  ]
  const discogsColumns: DataTableColumn<ImportReview['candidates'][number]>[] = [
    {
      key: 'match',
      header: 'Match',
      cellClassName: 'max-w-[280px] truncate text-zinc-200',
      render: (row) => <span title={`${row.match.artist} - ${row.match.title}`}>{row.match.artist} - {row.match.title}{row.match.version ? ` (${row.match.version})` : ''}</span>
    },
    {
      key: 'release',
      header: 'Release',
      cellClassName: 'max-w-[220px] truncate text-zinc-400',
      render: (row) => <span title={row.match.releaseTitle}>{row.match.releaseTitle}</span>
    },
    { key: 'year', header: 'Year', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => row.match.year ?? '—' },
    { key: 'len', header: 'Len', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => formatCompactDuration(row.match.durationSeconds) },
    { key: 'type', header: 'Type', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => summarizeMediaType(row.match.format) },
    { key: 'score', header: 'Score', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => row.match.score.toFixed(0) },
    { key: 'link', header: 'D', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => <SourceIconLink url={buildDiscogsReleaseUrl(row.match.releaseId)} label="Discogs release" /> },
    { key: 'flags', header: '', cellClassName: 'w-[1%]', render: (row) => row.exactExistingFilename ? <Pill className="border-violet-700/50 bg-violet-950/30 text-violet-100">existing</Pill> : null }
  ]

  if (!filename) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <SectionKicker>Import</SectionKicker>
        <div className="mt-1 text-sm text-zinc-300">Missing file selection.</div>
        <ActionButton size="xs" onClick={onClose}>Back To Import</ActionButton>
      </div>
    )
  }

  const updateTagField = (key: keyof TagDraft, value: string): void => {
    dirtyTagRef.current[key] = true
    setTagDraft((current) => ({ ...current, [key]: value }))
  }

  async function loadComparison(currentFilename: string, existingFilename: string, resetTime: boolean = true): Promise<void> {
    const requestId = ++compareRequestRef.current
    audio.pausePlayback()
    try {
      const nextComparison = await api.collection.compareImport(currentFilename, existingFilename)
      if (requestId !== compareRequestRef.current) return
      setComparison(nextComparison)
      setErrorMessage(null)
      if (!resetTime) return
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
      audio.pausePlayback()
      await api.collection.deleteFile(filename)
      await onDeleted()
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

  const sourceStats = [
    ['Year', sourceYear || '—'],
    ['Format', formatFormat((comparison?.sourceAnalysis ?? review?.sourceAnalysis)?.format ?? filename.match(/\.[^.]+$/)?.[0]?.slice(1) ?? null)],
    ['Quality', formatScore(sourceQualityScore), sourceQualityTitle],
    ['Length', formatCompactDuration((comparison?.sourceAnalysis ?? review?.sourceAnalysis)?.durationSeconds ?? null)]
  ] as const
  const targetStats = [
    [
      'Replace Target',
      selectedCompareItem
        ? (selectedCompareItem.recordingCanonical?.artist ?? selectedCompareItem.importArtist ?? guessMeta(selectedCompareItem.filename).artist)
        : 'None',
      selectedExistingFilename ?? 'No selected existing file'
    ],
    ['Existing Quality', formatScore(selectedExistingQualityScore), selectedExistingQualityTitle],
    ['Discogs Release', selectedReleaseLabel ?? 'None', selectedCandidate?.match.releaseTitle ?? 'No selected Discogs candidate'],
    ['Dest', destinationPreview ?? 'Pending', destinationPreview ?? 'No destination preview yet']
  ] as const
  const tagFields = [
    ['artist', 'Artist'],
    ['title', 'Title'],
    ['album', 'Album'],
    ['year', 'Year'],
    ['label', 'Label'],
    ['catalogNumber', 'Catalog #'],
    ['trackPosition', 'Track #'],
    ['discogsReleaseId', 'Discogs Release'],
    ['discogsTrackPosition', 'Discogs Track']
  ] as const satisfies ReadonlyArray<readonly [keyof TagDraft, string]>

  return (
    <div className="space-y-2">
      <div className="relative rounded-xl bg-zinc-950">
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
              <div className="grid gap-2 bg-zinc-900/20 p-2 lg:grid-cols-[1.2fr,1fr]">
                <div className="space-y-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SectionKicker>Current File</SectionKicker>
                      {queueText ? <Pill>{queueText}</Pill> : null}
                    </div>
                    <div className="mt-1 text-base font-semibold text-zinc-100">{sourceArtist} - {sourceTitle}</div>
                    <div className="truncate text-[11px] text-zinc-500">{filename}</div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-4">
                    {sourceStats.map(([label, value, title]) => (
                      <MiniStat key={label} label={label} value={value} title={title} />
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <SourceIconLink url={currentItem?.recordingDiscogsUrl} label="Current Discogs" className="h-6 w-6" />
                    <SourceIconLink url={currentItem?.recordingMusicBrainzUrl} label="Current MusicBrainz" className="h-6 w-6" />
                    <SourceIconLink url={selectedReleaseUrl} label="Selected Discogs release" className="h-6 w-6" />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {targetStats.map(([label, value, title]) => (
                      <MiniStat key={label} label={label} value={value} title={title} />
                    ))}
                  </div>
                </div>
              </div>
              <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-950/92 px-2.5 py-2 backdrop-blur">
                <div className="flex min-w-[180px] flex-1 items-center gap-1 text-[9px] text-zinc-500">
                  <span className="shrink-0">New</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={audio.crossfade}
                    disabled={!comparison}
                    onChange={(event) => audio.setCrossfade(Number(event.target.value))}
                    className="w-full"
                    aria-label="Crossfader"
                  />
                  <span className="shrink-0">Existing</span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ActionButton size="xs" disabled={loading || deleteLoading || commitLoading !== null} onClick={() => { void handleRefresh() }}>
                    Refresh
                  </ActionButton>
                  <ActionButton size="xs" tone={showAnalysis ? 'primary' : 'default'} disabled={loading} onClick={() => setShowAnalysis((value) => !value)}>
                    {showAnalysis ? 'Hide Analysis' : 'Show Analysis'}
                  </ActionButton>
                  <ActionButton size="xs" tone={showAdvanced ? 'primary' : 'default'} disabled={loading} onClick={() => setShowAdvanced((value) => !value)}>
                    {showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
                  </ActionButton>
                  {hasLocalMatches && !showImportTools ? (
                    <ActionButton size="xs" disabled={deleteLoading || commitLoading !== null} onClick={() => { setShowImportTools(true); setShowAdvanced(true) }}>
                      Tag + Import
                    </ActionButton>
                  ) : null}
                  <ActionButton
                    size="xs"
                    tone="default"
                    className="border-rose-700/50 bg-rose-950/20 text-rose-100 hover:bg-rose-950/40"
                    disabled={deleteLoading || commitLoading !== null}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </ActionButton>
                  {showImportAction ? (
                    <ActionButton
                      size="xs"
                      tone="primary"
                      disabled={!canCommit || commitLoading !== null || deleteLoading}
                      onClick={() => {
                        void handleCommit('import')
                      }}
                    >
                      {commitLoading === 'import' ? 'Importing…' : hasLocalMatches ? 'Import New' : 'Import'}
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
                      Replace
                    </ActionButton>
                  )}
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-[0.95fr,1.05fr]">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <SectionKicker>Local Matches</SectionKicker>
                    <div className="text-[11px] text-zinc-500">Choose the existing file to replace, or leave this empty and import new.</div>
                    <div className="max-h-44 overflow-auto pr-1">
                      {review.similarItems.length === 0 ? (
                        <Notice>No similar tracks found in the collection.</Notice>
                      ) : (
                        <DataTable
                          columns={localColumns}
                          rows={review.similarItems}
                          getRowKey={(row) => row.filename}
                          getRowTitle={(row) => row.filename}
                          onRowClick={(row) => selectExisting(row.filename)}
                          rowClassName={(row) => selectedExistingFilename === row.filename ? 'bg-zinc-800/30' : ''}
                          className="rounded-md"
                          tableClassName="min-w-[760px]"
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <SectionKicker>Discogs Matches</SectionKicker>
                    <div className="text-[11px] text-zinc-500">Pick the best release/track match. Prefer the original single or EP cut over albums and compilations.</div>
                    {destinationPreview ? <div className="truncate text-[10px] text-zinc-500">{destinationPreview}</div> : null}
                    <div className="max-h-44 overflow-auto pr-1">
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
                          tableClassName="min-w-[900px]"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
              {showAnalysis ? (
                <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                  <SectionKicker>Analysis</SectionKicker>
                  <AudioCompareControls
                    left={{
                      label: 'New',
                      playing: audio.sourcePlaying,
                      time: audio.sourceTime,
                      duration: audio.sourceDuration || review.sourceAnalysis?.durationSeconds || null,
                      playLabel: 'Play new',
                      pauseLabel: 'Pause new',
                      onToggle: audio.sourcePlaying ? audio.pausePlayback : audio.playSource,
                      onSeek: audio.syncSourceTime
                    }}
                    right={{
                      label: 'Existing',
                      playing: audio.existingPlaying,
                      disabled: !comparison,
                      time: audio.existingTime,
                      duration: audio.existingDuration || comparison?.existingAnalysis?.durationSeconds || null,
                      playLabel: 'Play existing',
                      pauseLabel: 'Pause existing',
                      onToggle: audio.existingPlaying ? audio.pausePlayback : audio.playExisting,
                      onSeek: audio.syncExistingTime
                    }}
                    linked={audio.linkPlayers}
                    onToggleLinked={() => audio.setLinkPlayers((value) => !value)}
                    crossfade={audio.crossfade}
                    onCrossfade={audio.setCrossfade}
                    crossfadeDisabled={!comparison}
                  />
                  <ImportReviewOverviewTable
                    filename={filename}
                    parsed={review.parsed}
                    sourceAnalysis={comparison?.sourceAnalysis ?? review.sourceAnalysis}
                    selectedCandidate={selectedCandidate}
                    selectedItem={selectedCompareItem}
                    existingAnalysis={comparison?.existingAnalysis ?? null}
                  />
                </div>
              ) : null}
              {showAdvanced ? (
                <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                  <SectionKicker>Advanced</SectionKicker>
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void handleRefine()
                    }}
                  >
                    <CompactInput
                      label="Artist"
                      value={searchDraft.artist}
                      onChange={(event) => setSearchDraft((value) => ({ ...value, artist: event.target.value }))}
                      placeholder="Artist"
                      className="min-w-[140px] flex-1"
                    />
                    <CompactInput
                      label="Title"
                      value={searchDraft.title}
                      onChange={(event) => setSearchDraft((value) => ({ ...value, title: event.target.value }))}
                      placeholder="Title"
                      className="min-w-[180px] flex-[1.2]"
                    />
                    <CompactInput
                      label="Version"
                      value={searchDraft.version}
                      onChange={(event) => setSearchDraft((value) => ({ ...value, version: event.target.value }))}
                      placeholder="Version"
                      className="min-w-[120px] flex-1"
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
                  {!selectedCandidate ? (
                    <Notice tone="warning">No Discogs candidate available for this file.</Notice>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {tagFields.map(([key, label]) => (
                        <CompactInput
                          key={key}
                          label={label}
                          value={tagDraft[key]}
                          onChange={(event) => updateTagField(key, event.target.value)}
                        />
                      ))}
                    </div>
                  )}
                  {!review.tagWriteSupported ? <Notice tone="warning">This format is not tag-writable yet. Import/replacement still works, but tag writing is skipped.</Notice> : null}
                </div>
              ) : null}
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

        <audio {...audio.sourceAudioProps} />
        {comparison ? <audio {...audio.existingAudioProps} /> : null}
      </div>
    </div>
  )
}

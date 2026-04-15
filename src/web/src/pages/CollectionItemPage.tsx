import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { CollectionItemDetails } from '../../../shared/api'
import { api } from '../api/client'
import { ActionButton, Notice, ViewSection } from '../components/view'
import { usePlayer } from '../context/PlayerContext'
import { getErrorMessage } from '../lib/error-utils'
import { deriveTrackSummaryFromFilename, formatFileSize } from '../lib/music-file'

function fmtDate(value: string | number | null | undefined): string {
  if (value == null) return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function JsonBlock({ value }: { value: string | null | undefined }): React.JSX.Element {
  if (!value) return <div className="text-zinc-500">—</div>
  return (
    <details className="rounded border border-zinc-800 bg-zinc-950/40">
      <summary className="cursor-pointer px-2 py-1 text-[11px] text-zinc-400">Show JSON</summary>
      <pre className="max-h-64 overflow-auto border-t border-zinc-800 p-2 text-[10px] leading-4 text-zinc-300">{value}</pre>
    </details>
  )
}

function KV({
  rows
}: {
  rows: Array<{ label: string; value: React.ReactNode }>
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-x-2 gap-y-1 text-xs">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <div className="text-zinc-500">{row.label}</div>
          <div className="min-w-0 break-all text-zinc-200">{row.value}</div>
        </div>
      ))}
    </div>
  )
}

export default function CollectionItemPage(): React.JSX.Element {
  const navigate = useNavigate()
  const player = usePlayer()
  const [params] = useSearchParams()
  const filename = (params.get('filename') ?? '').trim()
  const [item, setItem] = useState<CollectionItemDetails | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<'sync' | 'reanalyze' | 'mark-reanalyzed' | 'identify' | null>(null)
  const [busyCandidateId, setBusyCandidateId] = useState<number | 'create' | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadItem = useCallback(async (): Promise<void> => {
    if (!filename) {
      setItem(null)
      return
    }
    setIsLoading(true)
    try {
      setItem(await api.collection.get(filename))
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to load collection item'))
      setItem(null)
    } finally {
      setIsLoading(false)
    }
  }, [filename])

  useEffect(() => {
    void loadItem()
  }, [loadItem])

  const summary = useMemo(
    () =>
      item
        ? {
            ...deriveTrackSummaryFromFilename(item.filename),
            artist: item.recordingCanonical?.artist || deriveTrackSummaryFromFilename(item.filename).artist,
            title: item.recordingCanonical?.title
              ? `${item.recordingCanonical.title}${item.recordingCanonical.version ? ` (${item.recordingCanonical.version})` : ''}`
              : deriveTrackSummaryFromFilename(item.filename).title,
            year: item.recordingCanonical?.year || deriveTrackSummaryFromFilename(item.filename).year
          }
        : { artist: 'Unknown artist', title: 'Unknown title', year: '' },
    [item]
  )

  const handleSync = useCallback(async (): Promise<void> => {
    setBusyAction('sync')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.syncNow()
      await loadItem()
      setActionMessage('Collection synced.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to sync collection'))
    } finally {
      setBusyAction(null)
    }
  }, [loadItem])

  const handleReanalyze = useCallback(async (): Promise<void> => {
    if (!item) return
    setBusyAction('reanalyze')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.reanalyze(item.filename)
      await loadItem()
      setActionMessage('Reanalysis completed.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to reanalyze'))
    } finally {
      setBusyAction(null)
    }
  }, [item, loadItem])

  const handleMarkReanalyzed = useCallback(async (): Promise<void> => {
    if (!item?.upgradeCase) return
    setBusyAction('mark-reanalyzed')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.upgrades.markReanalyzed(item.upgradeCase.id)
      await loadItem()
      setActionMessage('Upgrade marked as reanalyzed.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to mark reanalyzed'))
    } finally {
      setBusyAction(null)
    }
  }, [item, loadItem])

  const handleIdentify = useCallback(async (): Promise<void> => {
    if (!item) return
    setBusyAction('identify')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.queueIdentificationProcessing([item.filename], true)
      await loadItem()
      setActionMessage('Identification refresh queued.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to queue identification'))
    } finally {
      setBusyAction(null)
    }
  }, [item, loadItem])

  const handleReviewIdentification = useCallback(
    async (action: 'accept' | 'reject' | 'create_recording', candidateId?: number | null): Promise<void> => {
      if (!item) return
      setBusyCandidateId(action === 'create_recording' ? 'create' : candidateId ?? null)
      setActionMessage(null)
      setActionError(null)
      try {
        await api.collection.reviewIdentification({
          filename: item.filename,
          action,
          candidateId: typeof candidateId === 'number' ? candidateId : undefined
        })
        await loadItem()
        setActionMessage(action === 'reject' ? 'Candidate rejected.' : 'Identification updated.')
      } catch (error) {
        setActionError(getErrorMessage(error, 'Failed to update identification'))
      } finally {
        setBusyCandidateId(null)
      }
    },
    [item, loadItem]
  )

  return (
    <div className="space-y-3">
      <ViewSection
        title={summary.title}
        subtitle={item ? `${summary.artist}${summary.year ? ` · ${summary.year}` : ''}` : 'Collection item'}
        aside={
          <div className="flex flex-wrap gap-2">
            <ActionButton size="xs" onClick={() => navigate('/collection')}>
              Back
            </ActionButton>
            {item ? (
              <>
                <ActionButton
                  size="xs"
                  tone="primary"
                  onClick={() =>
                    player.play({
                      url: `/api/media?filename=${encodeURIComponent(item.filename)}`,
                      filename: item.filename,
                      title: summary.title,
                      artist: summary.artist !== 'Unknown artist' ? summary.artist : ''
                    })
                  }
                >
                  Play
                </ActionButton>
                <ActionButton size="xs" onClick={() => void api.collection.showInFinder(item.filename)}>
                  Finder
                </ActionButton>
                <ActionButton size="xs" onClick={() => void api.collection.openInPlayer(item.filename)}>
                  Open Player
                </ActionButton>
                <ActionButton
                  size="xs"
                  disabled={busyAction === 'reanalyze'}
                  title="Recompute audio/hash analysis for this file"
                  onClick={() => void handleReanalyze()}
                >
                  {busyAction === 'reanalyze' ? 'Reanalyzing…' : 'Reanalyze'}
                </ActionButton>
                <ActionButton size="xs" disabled={busyAction === 'identify'} onClick={() => void handleIdentify()}>
                  {busyAction === 'identify' ? 'Queuing…' : 'Reidentify'}
                </ActionButton>
                <ActionButton size="xs" onClick={() => navigate(`/identify?scope=${item.isDownload ? 'downloads' : 'collection'}&filename=${encodeURIComponent(item.filename)}`)}>
                  Review Identify
                </ActionButton>
                <ActionButton size="xs" disabled={busyAction === 'sync'} onClick={() => void handleSync()}>
                  {busyAction === 'sync' ? 'Rescanning…' : 'Rescan'}
                </ActionButton>
                {item.upgradeCase?.status === 'pending_reanalyze' ? (
                  <ActionButton size="xs" tone="success" disabled={busyAction === 'mark-reanalyzed'} onClick={() => void handleMarkReanalyzed()}>
                    {busyAction === 'mark-reanalyzed' ? 'Saving…' : 'Mark Reanalyzed'}
                  </ActionButton>
                ) : null}
                <ActionButton
                  size="xs"
                  onClick={() => {
                    if (item.upgradeCase) navigate(`/upgrades/${item.upgradeCase.id}`)
                    else void api.upgrades.open(item.filename).then((next) => navigate(`/upgrades/${next.id}`))
                  }}
                >
                  {item.upgradeCase ? 'Open Upgrade' : 'Create Upgrade'}
                </ActionButton>
              </>
            ) : null}
          </div>
        }
      >
        <div className="text-xs text-zinc-500">{filename || 'Missing filename query parameter.'}</div>
      </ViewSection>

      {isLoading ? <Notice className="text-sm">Loading item…</Notice> : null}
      {errorMessage ? <Notice tone="error" className="text-sm">{errorMessage}</Notice> : null}
      {actionError ? <Notice tone="error" className="text-sm">{actionError}</Notice> : null}
      {actionMessage ? <Notice tone="success" className="text-sm">{actionMessage}</Notice> : null}
      {!isLoading && filename && !item && !errorMessage ? (
        <Notice tone="warning" className="text-sm">Item not found in collection.</Notice>
      ) : null}

      {item ? (
        <>
          <ViewSection title="Core" padding="sm">
            <KV
              rows={[
                { label: 'Filename', value: item.filename },
                { label: 'Filesize', value: `${formatFileSize(item.filesize)} (${item.filesize} bytes)` },
                { label: 'Mtime', value: fmtDate(item.mtimeMs) },
                { label: 'Type', value: item.isDownload ? 'Download/import file' : 'Collection/library file' }
              ]}
            />
          </ViewSection>

          <ViewSection title="Import Cache" padding="sm">
            {item.importReview ? (
              <>
                <KV
                  rows={[
                    { label: 'Status', value: item.importReview.status },
                    { label: 'Review version', value: item.importReview.reviewVersion },
                    { label: 'Artist', value: item.importReview.parsedArtist || '—' },
                    { label: 'Title', value: item.importReview.parsedTitle || '—' },
                    { label: 'Version', value: item.importReview.parsedVersion || '—' },
                    { label: 'Year', value: item.importReview.parsedYear || '—' },
                    { label: 'Processed', value: fmtDate(item.importReview.processedAt) },
                    { label: 'Error', value: item.importReview.errorMessage || '—' }
                  ]}
                />
                <div className="mt-2">
                  <JsonBlock value={item.importReview.reviewJson} />
                </div>
              </>
            ) : (
              <div className="text-xs text-zinc-500">No row in `import_review_cache`.</div>
            )}
          </ViewSection>

          <ViewSection title="Audio Cache" padding="sm">
            {item.fileAudioState ? (
              <>
                <KV
                  rows={[
                    { label: 'Status', value: item.fileAudioState.status },
                    { label: 'Hash version', value: item.fileAudioState.hashVersion },
                    { label: 'Audio hash', value: item.fileAudioState.audioHash || '—' },
                    { label: 'Processed', value: fmtDate(item.fileAudioState.processedAt) },
                    { label: 'Error', value: item.fileAudioState.errorMessage || '—' }
                  ]}
                />
                <div className="mt-2">
                  {item.audioAnalysisCache ? (
                    <KV
                      rows={[
                        { label: 'Analysis version', value: item.audioAnalysisCache.analysisVersion },
                        { label: 'Analysis processed', value: fmtDate(item.audioAnalysisCache.processedAt) },
                        { label: 'Analysis error', value: item.audioAnalysisCache.errorMessage || '—' },
                        { label: 'Duration (s)', value: item.parsedAudioAnalysis?.durationSeconds ?? '—' },
                        { label: 'Bitrate (kbps)', value: item.parsedAudioAnalysis?.bitrateKbps ?? '—' },
                        { label: 'Loudness LUFS', value: item.parsedAudioAnalysis?.integratedLufs ?? '—' }
                      ]}
                    />
                  ) : (
                    <div className="text-xs text-zinc-500">No row in `audio_analysis_cache`.</div>
                  )}
                </div>
                <div className="mt-2">
                  <JsonBlock value={item.audioAnalysisCache?.analysisJson} />
                </div>
              </>
            ) : (
              <div className="text-xs text-zinc-500">No row in `file_audio_state`.</div>
            )}
          </ViewSection>

          <ViewSection title="Identification" padding="sm">
            {item.identification ? (
              <>
                <KV
                  rows={[
                    { label: 'Status', value: item.identification.status },
                    { label: 'Recording id', value: item.identification.recordingId ?? '—' },
                    { label: 'Method', value: item.identification.assignmentMethod || '—' },
                    { label: 'Confidence', value: item.identification.confidence ?? '—' },
                    {
                      label: 'Canonical',
                      value:
                        item.identification.recordingCanonical?.title || item.identification.recordingCanonical?.artist
                          ? `${item.identification.recordingCanonical?.artist || '—'} · ${item.identification.recordingCanonical?.title || '—'}${item.identification.recordingCanonical?.version ? ` (${item.identification.recordingCanonical.version})` : ''}${item.identification.recordingCanonical?.year ? ` · ${item.identification.recordingCanonical.year}` : ''}`
                          : '—'
                    },
                    { label: 'Parsed', value: `${item.identification.parsedArtist || '—'} · ${item.identification.parsedTitle || '—'}${item.identification.parsedVersion ? ` (${item.identification.parsedVersion})` : ''}` },
                    { label: 'Tags', value: `${item.identification.tagArtist || '—'} · ${item.identification.tagTitle || '—'}${item.identification.tagVersion ? ` (${item.identification.tagVersion})` : ''}` },
                    { label: 'Audio hash', value: item.identification.audioHash || '—' },
                    { label: 'Processed', value: fmtDate(item.identification.processedAt) },
                    { label: 'Error', value: item.identification.errorMessage || '—' }
                  ]}
                />
                <div className="mt-2">
                  <JsonBlock value={item.identification.explanationJson} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton size="xs" tone="primary" disabled={busyCandidateId === 'create'} onClick={() => void handleReviewIdentification('create_recording')}>
                    {busyCandidateId === 'create' ? 'Creating…' : 'Create Recording'}
                  </ActionButton>
                </div>
                {item.identification.candidates.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {item.identification.candidates.map((candidate) => (
                      <div key={candidate.id} className="rounded border border-zinc-800 bg-zinc-950/40 p-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-zinc-100">
                              {candidate.provider} · {candidate.entityType} · score {candidate.score}
                            </div>
                            <div className="truncate text-zinc-500">{candidate.externalKey}</div>
                            <div className="text-zinc-300">
                              {candidate.recordingCanonical?.artist || '—'} · {candidate.recordingCanonical?.title || '—'}
                              {candidate.recordingCanonical?.version ? ` (${candidate.recordingCanonical.version})` : ''}
                              {candidate.recordingCanonical?.year ? ` · ${candidate.recordingCanonical.year}` : ''}
                            </div>
                            <div className="text-zinc-500">Disposition: {candidate.disposition}</div>
                          </div>
                          <div className="flex gap-2">
                            <ActionButton size="xs" tone="primary" disabled={busyCandidateId === candidate.id} onClick={() => void handleReviewIdentification('accept', candidate.id)}>
                              {busyCandidateId === candidate.id ? 'Saving…' : 'Accept'}
                            </ActionButton>
                            <ActionButton size="xs" disabled={busyCandidateId === candidate.id} onClick={() => void handleReviewIdentification('reject', candidate.id)}>
                              Reject
                            </ActionButton>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-xs text-zinc-500">No row in `file_identification_state`.</div>
            )}
          </ViewSection>

          <ViewSection title="Upgrade Case" padding="sm">
            {item.upgradeCase ? (
              <KV
                rows={[
                  { label: 'Case id', value: item.upgradeCase.id },
                  { label: 'Status', value: item.upgradeCase.status },
                  { label: 'Search artist', value: item.upgradeCase.searchArtist },
                  { label: 'Search title', value: item.upgradeCase.searchTitle },
                  { label: 'Search version', value: item.upgradeCase.searchVersion || '—' },
                  { label: 'Updated', value: fmtDate(item.upgradeCase.updatedAt) }
                ]}
              />
            ) : (
              <div className="text-xs text-zinc-500">No row in `upgrade_cases`.</div>
            )}
          </ViewSection>
        </>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CollectionItem, CollectionItemDetails, RecordingCanonical, RecordingDetails } from '../../../shared/api'
import type { OnlineSearchItem } from '../../../shared/online-search'
import { api } from '../api/client'
import { AudioCompareControls } from './AudioCompareControls'
import {
  ActionButton,
  CompactInput,
  DataTable,
  Notice,
  Pill,
  QueryBar,
  SectionKicker,
  SourceIconLink,
  ViewPanel,
  ViewSection,
  type DataTableColumn
} from './view'
import { localFileUrl } from '../context/PlayerContext'
import { useAudioCompare } from '../hooks/useAudioCompare'
import { getErrorMessage } from '../lib/error-utils'
import { withVersion } from '../lib/importReview'
import { extractYouTubeId } from '../lib/youtube'
import { deriveTrackSummaryFromFilename, formatCompactDuration } from '../lib/music-file'

type Draft = { artist: string; title: string; version: string; year: string }

function toDraft(item: CollectionItemDetails | null): Draft {
  const parsed = item?.identification
  const canonical = parsed?.recordingCanonical ?? item?.recordingCanonical
  const fallback = item ? deriveTrackSummaryFromFilename(item.filename) : { artist: '', title: '', year: '' }
  return {
    artist: canonical?.artist ?? parsed?.parsedArtist ?? parsed?.tagArtist ?? fallback.artist,
    title: canonical?.title ?? parsed?.parsedTitle ?? parsed?.tagTitle ?? fallback.title,
    version: canonical?.version ?? parsed?.parsedVersion ?? parsed?.tagVersion ?? '',
    year: canonical?.year ?? parsed?.parsedYear ?? fallback.year.replace('—', '')
  }
}

function toCanonical(draft: Draft): Partial<RecordingCanonical> {
  const text = (value: string): string | null => value.trim() || null
  return {
    artist: text(draft.artist),
    title: text(draft.title),
    version: text(draft.version),
    year: text(draft.year)
  }
}

function buildSearchText(draft: Draft): string {
  return [draft.artist, draft.title, draft.version].map((value) => value.trim()).filter(Boolean).join(' ')
}

function buildDiscogsSearchUrl(query: string): string {
  return `https://www.discogs.com/search/?q=${encodeURIComponent(query)}&type=all`
}

function buildMusicBrainzSearchUrl(query: string): string {
  return `https://musicbrainz.org/search?query=${encodeURIComponent(query)}&type=recording&method=indexed`
}

function discogsReleaseUrl(claim: RecordingDetails['sourceClaims'][number] | null): string | null {
  if (!claim) return null
  const match = claim.externalKey.match(/discogs:release:(\d+)/i)
  return match ? `https://www.discogs.com/release/${match[1]}` : null
}

function musicBrainzRecordingUrl(claim: RecordingDetails['sourceClaims'][number] | null): string | null {
  if (!claim) return null
  const match = claim.externalKey.match(/musicbrainz:recording:([a-f0-9-]+)/i)
  return match ? `https://musicbrainz.org/recording/${match[1]}` : null
}

function ClaimCard({
  title,
  line1,
  line2,
  storedUrl,
  searchUrl,
  storedLabel,
  searchLabel
}: {
  title: string
  line1: React.ReactNode
  line2?: React.ReactNode
  storedUrl?: string | null
  searchUrl: string
  storedLabel: string
  searchLabel: string
}): React.JSX.Element {
  return (
    <ViewPanel tone="muted" padding="sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <SectionKicker>{title}</SectionKicker>
          <div className="mt-1 text-xs font-medium text-zinc-100">{line1}</div>
          {line2 ? <div className="mt-0.5 text-[11px] text-zinc-500">{line2}</div> : null}
        </div>
        <div className="flex items-center gap-1">
          <SourceIconLink url={storedUrl} label={storedLabel} />
          <SourceIconLink url={searchUrl} label={searchLabel} />
        </div>
      </div>
    </ViewPanel>
  )
}

function FieldGrid({
  rows
}: {
  rows: Array<{ label: string; value: React.ReactNode }>
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <div className="text-zinc-500">{row.label}</div>
          <div className="min-w-0 break-all text-zinc-200">{row.value}</div>
        </div>
      ))}
    </div>
  )
}

export function IdentificationReviewPanel({
  filename,
  onChanged
}: {
  filename: string
  onChanged?: () => Promise<void> | void
}): React.JSX.Element {
  const [item, setItem] = useState<CollectionItemDetails | null>(null)
  const [recording, setRecording] = useState<RecordingDetails | null>(null)
  const [similarItems, setSimilarItems] = useState<CollectionItem[]>([])
  const [similarLoading, setSimilarLoading] = useState(false)
  const [youtubeQuery, setYoutubeQuery] = useState('')
  const [youtubeItems, setYoutubeItems] = useState<OnlineSearchItem[]>([])
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [recordingQuery, setRecordingQuery] = useState('')
  const [recordingResults, setRecordingResults] = useState<RecordingDetails[]>([])
  const [recordingSearchLoading, setRecordingSearchLoading] = useState(false)
  const [draft, setDraft] = useState<Draft>({ artist: '', title: '', version: '', year: '' })
  const [selectedSimilarFilename, setSelectedSimilarFilename] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [youtubeLoading, setYoutubeLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const loadItem = useCallback(async (): Promise<void> => {
    setLoading(true)
    setErrorMessage(null)
    setActionMessage(null)
    try {
      const next = await api.collection.get(filename)
      setItem(next)
      const nextDraft = toDraft(next)
      const query = buildSearchText(nextDraft)
      setDraft(nextDraft)
      setYoutubeQuery(query)
      setRecordingQuery(query)
      if (next?.recordingId) {
        setRecording(await api.collection.getRecording(next.recordingId))
      } else {
        setRecording(null)
      }
      if (next) {
        await Promise.all([loadSimilarItems(query, next.filename), loadRecordingResults(query), loadYoutube(query)])
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to load identification review'))
      setItem(null)
      setRecording(null)
    } finally {
      setLoading(false)
    }
  }, [filename])

  const loadRecordingResults = useCallback(async (query: string): Promise<void> => {
    if (!query.trim()) {
      setRecordingResults([])
      return
    }
    setRecordingSearchLoading(true)
    try {
      const rows = await api.collection.listRecordings(query)
      const details = await Promise.all(rows.slice(0, 8).map((row) => api.collection.getRecording(row.id)))
      setRecordingResults(details.filter((row): row is RecordingDetails => Boolean(row)))
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to search recordings'))
      setRecordingResults([])
    } finally {
      setRecordingSearchLoading(false)
    }
  }, [])

  const loadSimilarItems = useCallback(async (query: string, currentFilename: string): Promise<void> => {
    if (!query.trim()) {
      setSimilarItems([])
      setSelectedSimilarFilename(null)
      return
    }
    setSimilarLoading(true)
    try {
      const result = await api.collection.list(query, 60)
      const next = result.items.filter((row) => !row.isDownload && row.filename !== currentFilename).slice(0, 12)
      setSimilarItems(next)
      setSelectedSimilarFilename((current) => (current && next.some((row) => row.filename === current) ? current : next[0]?.filename ?? null))
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to load similar collection files'))
      setSimilarItems([])
      setSelectedSimilarFilename(null)
    } finally {
      setSimilarLoading(false)
    }
  }, [])

  const loadYoutube = useCallback(async (query: string): Promise<void> => {
    if (!query.trim()) {
      setYoutubeItems([])
      setActiveVideoId(null)
      return
    }
    setYoutubeLoading(true)
    try {
      const result = await api.youtube.search(query)
      const next = result.items.filter((row) => Boolean(extractYouTubeId(row.link))).slice(0, 8)
      setYoutubeItems(next)
      setActiveVideoId((current) => (current && next.some((row) => extractYouTubeId(row.link) === current) ? current : extractYouTubeId(next[0]?.link ?? '') ?? null))
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to search YouTube'))
      setYoutubeItems([])
      setActiveVideoId(null)
    } finally {
      setYoutubeLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadItem()
  }, [loadItem])

  const selectedSimilarItem = similarItems.find((row) => row.filename === selectedSimilarFilename) ?? null
  const audio = useAudioCompare({
    sourceUrl: localFileUrl('', filename),
    existingUrl: selectedSimilarFilename ? localFileUrl('', selectedSimilarFilename) : '',
    enabled: Boolean(selectedSimilarFilename),
    resetKey: `${filename}:${selectedSimilarFilename ?? ''}`
  })

  const searchText = useMemo(() => buildSearchText(draft), [draft])
  const identifiedTitle = useMemo(() => withVersion(draft.title || 'Unknown title', draft.version || null), [draft.title, draft.version])
  const summaryArtist = draft.artist || deriveTrackSummaryFromFilename(filename).artist
  const discogsClaim = recording?.sourceClaims.find((row) => row.provider === 'discogs') ?? null
  const musicBrainzClaim = recording?.sourceClaims.find((row) => row.provider === 'musicbrainz') ?? null
  const activeVideo = youtubeItems.find((row) => extractYouTubeId(row.link) === activeVideoId) ?? youtubeItems[0] ?? null
  const candidateColumns: DataTableColumn<NonNullable<CollectionItemDetails['identification']>['candidates'][number]>[] = [
    {
      key: 'provider',
      header: 'Provider',
      cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400',
      render: (row) => `${row.provider} · ${row.score.toFixed(0)}`
    },
    {
      key: 'title',
      header: 'Candidate',
      cellClassName: 'max-w-[320px] truncate',
      render: (row) =>
        `${row.recordingCanonical?.artist || '—'} - ${row.recordingCanonical?.title || '—'}${row.recordingCanonical?.version ? ` (${row.recordingCanonical.version})` : ''}${row.recordingCanonical?.year ? ` · ${row.recordingCanonical.year}` : ''}`
    },
    {
      key: 'external',
      header: 'External',
      cellClassName: 'max-w-[280px] truncate text-zinc-500',
      render: (row) => row.externalKey
    },
    {
      key: 'actions',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => (
        <div className="flex gap-1">
          <ActionButton size="xs" tone="primary" disabled={busyAction === `accept:${row.id}`} onClick={() => void handleAccept(row.id)}>
            {busyAction === `accept:${row.id}` ? 'Saving…' : 'Accept'}
          </ActionButton>
          <ActionButton size="xs" disabled={busyAction === `reject:${row.id}`} onClick={() => void handleReject(row.id)}>
            Reject
          </ActionButton>
        </div>
      )
    }
  ]
  const similarColumns: DataTableColumn<CollectionItem>[] = [
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[160px] truncate',
      render: (row) => row.recordingCanonical?.artist ?? deriveTrackSummaryFromFilename(row.filename).artist
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[260px] truncate',
      render: (row) => row.recordingCanonical?.title ? withVersion(row.recordingCanonical.title, row.recordingCanonical.version) : deriveTrackSummaryFromFilename(row.filename).title
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400',
      render: (row) => row.recordingCanonical?.year ?? '—'
    },
    {
      key: 'len',
      header: 'Len',
      cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400',
      render: (row) => formatCompactDuration(row.duration)
    }
  ]
  const recordingColumns: DataTableColumn<RecordingDetails>[] = [
    {
      key: 'canonical',
      header: 'Recording',
      cellClassName: 'max-w-[320px] truncate',
      render: (row) =>
        `${row.canonical.artist || '—'} - ${row.canonical.title || '—'}${row.canonical.version ? ` (${row.canonical.version})` : ''}${row.canonical.year ? ` · ${row.canonical.year}` : ''}`
    },
    {
      key: 'files',
      header: 'Files',
      cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400',
      render: (row) => row.fileCount
    },
    {
      key: 'use',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => (
        <ActionButton size="xs" tone="primary" disabled={busyAction === `assign:${row.id}`} onClick={() => void handleAssign(row.id)}>
          {busyAction === `assign:${row.id}` ? 'Saving…' : 'Use'}
        </ActionButton>
      )
    }
  ]

  async function reloadAll(message?: string): Promise<void> {
    await loadItem()
    await onChanged?.()
    if (message) setActionMessage(message)
  }

  async function handleAccept(candidateId: number): Promise<void> {
    setBusyAction(`accept:${candidateId}`)
    setErrorMessage(null)
    try {
      await api.collection.reviewIdentification({ filename, action: 'accept', candidateId })
      await reloadAll('Identification confirmed.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to accept identification'))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleReject(candidateId: number): Promise<void> {
    setBusyAction(`reject:${candidateId}`)
    setErrorMessage(null)
    try {
      await api.collection.reviewIdentification({ filename, action: 'reject', candidateId })
      await reloadAll('Candidate rejected.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to reject candidate'))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleAssign(recordingId: number): Promise<void> {
    setBusyAction(`assign:${recordingId}`)
    setErrorMessage(null)
    try {
      await api.collection.assignRecording({ recordingId, filenames: [filename] })
      await reloadAll('Recording assigned.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to assign recording'))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSaveCurrent(): Promise<void> {
    if (!item?.identification?.recordingId) return
    setBusyAction('save-current')
    setErrorMessage(null)
    try {
      await api.collection.assignRecording({
        recordingId: item.identification.recordingId,
        filenames: [filename],
        canonical: toCanonical(draft)
      })
      await reloadAll('Identification saved.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to save canonical recording'))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleCreateRecording(): Promise<void> {
    setBusyAction('create')
    setErrorMessage(null)
    try {
      await api.collection.assignRecording({
        filenames: [filename],
        create: true,
        canonical: toCanonical(draft)
      })
      await reloadAll('New recording created.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to create recording'))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleReidentify(): Promise<void> {
    setBusyAction('identify')
    setErrorMessage(null)
    try {
      await api.collection.queueIdentificationProcessing([filename], true)
      await reloadAll('Identification queued.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Failed to queue identification'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="space-y-3">
      {loading ? <Notice>Loading identification…</Notice> : null}
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      {actionMessage ? <Notice tone="success">{actionMessage}</Notice> : null}
      {!item ? null : (
        <>
          <ViewSection
            padding="sm"
            title={identifiedTitle}
            subtitle={`${summaryArtist}${draft.year ? ` · ${draft.year}` : ''}`}
            aside={
              <div className="flex flex-wrap gap-2">
                <Pill tone={item.isDownload ? 'primary' : 'muted'}>{item.isDownload ? 'Downloads' : 'Collection'}</Pill>
                {item.identification?.status ? <Pill>{item.identification.status}</Pill> : null}
                <ActionButton size="xs" onClick={() => void api.collection.showInFinder(item.filename)}>Finder</ActionButton>
                <ActionButton size="xs" onClick={() => void api.collection.openInPlayer(item.filename)}>Open Player</ActionButton>
                <ActionButton size="xs" disabled={busyAction === 'identify'} onClick={() => void handleReidentify()}>
                  {busyAction === 'identify' ? 'Queuing…' : 'Reidentify'}
                </ActionButton>
              </div>
            }
          >
            <FieldGrid
              rows={[
                { label: 'Path', value: item.filename },
                { label: 'Recording', value: item.identification?.recordingId ?? '—' },
                { label: 'Method', value: item.identification?.assignmentMethod ?? '—' },
                { label: 'Confidence', value: item.identification?.confidence ?? '—' }
              ]}
            />
          </ViewSection>

          <ViewSection title="Identification" padding="sm">
            <div className="grid gap-2 md:grid-cols-4">
              <CompactInput label="Artist" value={draft.artist} onChange={(event) => setDraft((current) => ({ ...current, artist: event.target.value }))} />
              <CompactInput label="Title" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
              <CompactInput label="Version" value={draft.version} onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} />
              <CompactInput label="Year" value={draft.year} onChange={(event) => setDraft((current) => ({ ...current, year: event.target.value }))} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <ActionButton
                size="xs"
                tone="primary"
                disabled={!item.identification?.recordingId || busyAction === 'save-current'}
                onClick={() => void handleSaveCurrent()}
              >
                {busyAction === 'save-current' ? 'Saving…' : 'Confirm Current'}
              </ActionButton>
              <ActionButton size="xs" disabled={busyAction === 'create'} onClick={() => void handleCreateRecording()}>
                {busyAction === 'create' ? 'Creating…' : 'Create New'}
              </ActionButton>
              <ActionButton size="xs" disabled={recordingSearchLoading} onClick={() => void loadRecordingResults(recordingQuery)}>
                {recordingSearchLoading ? 'Searching…' : 'Search Recordings'}
              </ActionButton>
            </div>
          </ViewSection>

          {item.identification?.candidates?.length ? (
            <ViewSection title="Candidates" padding="sm">
              <DataTable
                columns={candidateColumns}
                rows={item.identification.candidates}
                getRowKey={(row) => String(row.id)}
                tableClassName="min-w-[860px]"
              />
            </ViewSection>
          ) : null}

          <ViewSection title="Player" padding="sm">
            <AudioCompareControls
              left={{
                label: 'File',
                playing: audio.sourcePlaying,
                time: audio.sourceTime,
                duration: audio.sourceDuration || item.parsedAudioAnalysis?.durationSeconds || null,
                playLabel: 'Play file',
                pauseLabel: 'Pause file',
                onToggle: audio.sourcePlaying ? audio.pausePlayback : audio.playSource,
                onSeek: audio.syncSourceTime
              }}
              right={{
                label: 'Local Ref',
                playing: audio.existingPlaying,
                disabled: !selectedSimilarFilename,
                time: audio.existingTime,
                duration: audio.existingDuration || selectedSimilarItem?.duration || null,
                playLabel: 'Play local reference',
                pauseLabel: 'Pause local reference',
                onToggle: audio.existingPlaying ? audio.pausePlayback : audio.playExisting,
                onSeek: audio.syncExistingTime
              }}
              linked={audio.linkPlayers}
              onToggleLinked={() => audio.setLinkPlayers((value) => !value)}
              crossfade={audio.crossfade}
              onCrossfade={audio.setCrossfade}
              crossfadeDisabled={!selectedSimilarFilename}
            />
          </ViewSection>

          <div className="grid gap-3 xl:grid-cols-[0.9fr,1.1fr]">
            <div className="space-y-3">
              <ViewSection title="Discogs" padding="sm">
                <ClaimCard
                  title="Stored"
                  line1={
                    discogsClaim
                      ? `${discogsClaim.artist || '—'} - ${discogsClaim.title || '—'}${discogsClaim.version ? ` (${discogsClaim.version})` : ''}`
                      : 'No stored Discogs release'
                  }
                  line2={discogsClaim ? `${discogsClaim.releaseTitle || '—'}${discogsClaim.trackPosition ? ` · ${discogsClaim.trackPosition}` : ''}` : undefined}
                  storedUrl={discogsReleaseUrl(discogsClaim)}
                  searchUrl={buildDiscogsSearchUrl(searchText)}
                  storedLabel="Discogs release"
                  searchLabel="Discogs search"
                />
              </ViewSection>

              <ViewSection title="MusicBrainz" padding="sm">
                <ClaimCard
                  title="Stored"
                  line1={
                    musicBrainzClaim
                      ? `${musicBrainzClaim.artist || '—'} - ${musicBrainzClaim.title || '—'}${musicBrainzClaim.version ? ` (${musicBrainzClaim.version})` : ''}`
                      : 'No stored MusicBrainz recording'
                  }
                  line2={musicBrainzClaim ? `${musicBrainzClaim.releaseTitle || '—'}${musicBrainzClaim.trackPosition ? ` · ${musicBrainzClaim.trackPosition}` : ''}` : undefined}
                  storedUrl={musicBrainzRecordingUrl(musicBrainzClaim)}
                  searchUrl={buildMusicBrainzSearchUrl(searchText)}
                  storedLabel="MusicBrainz recording"
                  searchLabel="MusicBrainz search"
                />
              </ViewSection>

              <ViewSection title="YouTube" padding="sm">
                <QueryBar
                  label="YouTube Search"
                  value={youtubeQuery}
                  onChange={setYoutubeQuery}
                  onSubmit={() => void loadYoutube(youtubeQuery)}
                  buttonLabel="Search"
                  busyLabel="Searching…"
                  isBusy={youtubeLoading}
                />
                {activeVideo ? (
                  <div className="mt-2 space-y-2">
                    <div className="max-h-40 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/20">
                      {youtubeItems.map((row) => {
                        const id = extractYouTubeId(row.link)
                        if (!id) return null
                        const active = id === (activeVideoId ?? extractYouTubeId(activeVideo.link))
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setActiveVideoId(id)}
                            className={`block w-full border-t border-zinc-800 px-2 py-1.5 text-left text-[11px] ${active ? 'bg-amber-950/20 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900/60'}`}
                          >
                            <div className="truncate">{row.title}</div>
                            <div className="truncate text-zinc-500">{row.displayLink}</div>
                          </button>
                        )
                      })}
                    </div>
                    <ViewPanel tone="muted" padding="sm" className="overflow-hidden bg-black p-0">
                      <iframe
                        src={`https://www.youtube.com/embed/${extractYouTubeId(activeVideo.link)}`}
                        title={activeVideo.title}
                        allow="autoplay; encrypted-media; picture-in-picture"
                        allowFullScreen
                        className="aspect-video w-full"
                      />
                    </ViewPanel>
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-zinc-500">No YouTube result loaded.</div>
                )}
              </ViewSection>
            </div>

            <div className="space-y-3">
              <ViewSection title="Similar Local Files" padding="sm">
                <div className="mb-2 flex justify-end">
                  <ActionButton size="xs" disabled={similarLoading} onClick={() => item ? void loadSimilarItems(buildSearchText(draft), item.filename) : undefined}>
                    {similarLoading ? 'Refreshing…' : 'Refresh Similar'}
                  </ActionButton>
                </div>
                <DataTable
                  columns={similarColumns}
                  rows={similarItems}
                  loading={similarLoading}
                  emptyMessage="No local references found."
                  getRowKey={(row) => row.filename}
                  getRowTitle={(row) => row.filename}
                  rowClassName={(row) => (row.filename === selectedSimilarFilename ? 'bg-amber-950/20' : '')}
                  onRowClick={(row) => setSelectedSimilarFilename(row.filename)}
                />
                {selectedSimilarItem ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <ActionButton size="xs" onClick={() => void api.collection.openInPlayer(selectedSimilarItem.filename)}>Open Ref Player</ActionButton>
                    <ActionButton size="xs" onClick={() => void api.collection.showInFinder(selectedSimilarItem.filename)}>Finder</ActionButton>
                  </div>
                ) : null}
              </ViewSection>

              <ViewSection title="Recordings" padding="sm">
                <QueryBar
                  label="Recording Search"
                  value={recordingQuery}
                  onChange={setRecordingQuery}
                  onSubmit={() => void loadRecordingResults(recordingQuery)}
                  buttonLabel="Search"
                  busyLabel="Searching…"
                  isBusy={recordingSearchLoading}
                />
                <div className="mt-2">
                  <DataTable
                    columns={recordingColumns}
                    rows={recordingResults}
                    loading={recordingSearchLoading}
                    emptyMessage="No recording matches."
                    getRowKey={(row) => String(row.id)}
                    tableClassName="min-w-[760px]"
                  />
                </div>
              </ViewSection>
            </div>
          </div>

          <audio {...audio.sourceAudioProps} />
          {selectedSimilarFilename ? <audio {...audio.existingAudioProps} /> : null}
        </>
      )}
    </div>
  )
}

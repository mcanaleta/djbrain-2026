import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { CollectionItemDetails, RecordingDetails } from '../../../shared/api'
import { buildCollectionItemHeading, findDiscogsDisplayTrack } from '../../../shared/collection-item-display'
import type { TagRepairField, TagRepairRow } from '../../../shared/tag-repair'
import { buildTagRepairRows } from '../../../shared/tag-repair'
import { parseDurationString } from '../../../shared/track-matcher'
import { buildReplacementWantInput } from '../../../shared/want-list-input'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { KV } from '../components/view/KV'
import { Notice } from '../components/view/Notice'
import { PageHeader } from '../components/view/PageHeader'
import { Pill } from '../components/view/Pill'
import { SourceIconLink } from '../components/view/SourceIconLink'
import { ViewSection } from '../components/view/ViewSection'
import { usePlayer } from '../context/PlayerContext'
import { DiscogsTrackAssignDialog } from '../features/collection-item/DiscogsTrackAssignDialog'
import { DiscogsReleaseTracklist } from '../features/collection-item/DiscogsReleaseTracklist'
import { getErrorMessage } from '../lib/error-utils'
import { deriveTrackSummaryFromFilename, formatCompactDuration, formatFileSize } from '../lib/music-file'
import { buildDiscogsReleaseUrl, buildIdentifyReviewHref } from '../lib/urls'

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

type SourceClaim = RecordingDetails['sourceClaims'][number]

function shortHash(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}...${value.slice(-8)}` : '-'
}

function duration(value: number | null | undefined): string {
  return value == null ? '-' : `${formatCompactDuration(value)} (${value.toFixed(1)}s)`
}

function drift(fileSeconds: number | null | undefined, referenceSeconds: number | null | undefined): ReactNode {
  if (fileSeconds == null || referenceSeconds == null || referenceSeconds <= 0) return '-'
  const delta = fileSeconds - referenceSeconds
  const abs = Math.abs(delta)
  const percent = (delta / referenceSeconds) * 100
  const label = abs < 1 ? 'OK' : abs <= 5 ? 'minor drift' : 'DRIFT'
  const className = abs < 1 ? 'text-emerald-300' : abs <= 5 ? 'text-amber-300' : 'text-rose-300'
  return <span className={className}>{label}: {delta >= 0 ? '+' : ''}{delta.toFixed(1)}s / {percent >= 0 ? '+' : ''}{percent.toFixed(1)}%</span>
}

function releaseIdFromClaim(claim: SourceClaim | null, item: CollectionItemDetails): number | null {
  const keyMatch = claim?.externalKey.match(/discogs:release:(\d+)/i)
  return keyMatch ? Number(keyMatch[1]) : item.tags?.discogsReleaseId || null
}

function tagSummary(item: CollectionItemDetails): string {
  const tags = item.tags
  return tags ? `${tags.artist || '-'} - ${tags.title || '-'}${tags.version ? ` (${tags.version})` : ''}` : '-'
}

function tagRelease(item: CollectionItemDetails): string {
  const tags = item.tags
  return tags ? [tags.album, tags.label, tags.year].filter(Boolean).join(' / ') || '-' : '-'
}

function modelTitle(recording: RecordingDetails | null | undefined, item: CollectionItemDetails): string {
  const canonical = recording?.canonical ?? item.recordingCanonical
  return `${canonical?.artist || '-'} - ${canonical?.title || '-'}${canonical?.version ? ` (${canonical.version})` : ''}${canonical?.year ? ` / ${canonical.year}` : ''}`
}

function discogsSearchQuery(item: CollectionItemDetails, summary: { artist: string; title: string }): string {
  const artist = item.recordingCanonical?.artist || item.tags?.artist || summary.artist
  const title = item.recordingCanonical?.title || item.tags?.title || summary.title
  const version = item.recordingCanonical?.version || item.tags?.version
  return [artist, title, version].filter((value) => value && !String(value).startsWith('Unknown ')).join(' ')
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function Step({ title, status, children }: { title: string; status?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0 border-l border-zinc-800 pl-3">
      <div className="mb-1 flex items-center gap-1">
        <div className="text-[11px] font-semibold uppercase text-zinc-400">{title}</div>
        {status ? <Pill>{status}</Pill> : null}
      </div>
      {children}
    </div>
  )
}

function TagRepairValue({ row, busy, onRepair }: { row: TagRepairRow; busy: boolean; onRepair: (field: TagRepairField) => void }): React.JSX.Element {
  if (!row.expected) return <span className="text-zinc-500">-</span>
  if (row.matches) return <span className="font-medium text-emerald-300">OK</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-zinc-500">tag</span>
      <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-200">{row.current || '-'}</span>
      <span className="text-zinc-500">record</span>
      <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-200">{row.expected}</span>
      <ActionButton size="xs" tone="primary" disabled={busy} onClick={() => onRepair(row.field)}>
        {busy ? 'Writing...' : 'Assign tag'}
      </ActionButton>
    </span>
  )
}

export default function CollectionItemPage(): React.JSX.Element {
  const navigate = useNavigate()
  const player = usePlayer()
  const { itemId } = useParams<{ itemId: string }>()
  const [params] = useSearchParams()
  const filename = (params.get('filename') ?? '').trim()
  const numericItemId = Number(itemId)
  const hasItemId = typeof itemId === 'string'
  const hasValidItemId = Number.isInteger(numericItemId) && numericItemId > 0
  const itemLabel = hasItemId ? (itemId ?? '') : filename
  const [busyAction, setBusyAction] = useState<'sync' | 'reanalyze' | 'identify' | 'discogs' | 'upgrade' | null>(null)
  const [busyCandidateId, setBusyCandidateId] = useState<number | 'create' | null>(null)
  const [busyTagField, setBusyTagField] = useState<TagRepairField | null>(null)
  const [showDiscogsAssign, setShowDiscogsAssign] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const {
    data: item,
    error: itemError,
    isPending: isLoading,
    refetch
  } = useQuery({
    queryKey: ['collection', 'item', hasItemId ? numericItemId : filename],
    queryFn: () => api.collection.get(hasItemId ? numericItemId : filename),
    enabled: hasItemId ? hasValidItemId : Boolean(filename)
  })
  const errorMessage = hasItemId && !hasValidItemId
    ? 'Collection item id is invalid.'
    : itemError ? getErrorMessage(itemError, 'Failed to load collection item') : null
  const { data: recording, isPending: isRecordingLoading } = useQuery({
    queryKey: ['collection', 'recording', item?.recordingId ?? null],
    queryFn: () => item?.recordingId ? api.collection.getRecording(item.recordingId) : Promise.resolve(null),
    enabled: Boolean(item?.recordingId)
  })

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
  const hash = item?.fileAudioState?.audioHash ?? item?.identification?.audioHash ?? null
  const analysis = item?.parsedAudioAnalysis
  const chosenClaim = recording?.sourceClaims.find((claim) => claim.id === item?.identification?.chosenClaimId) ?? null
  const discogsClaim = chosenClaim?.provider === 'discogs' ? chosenClaim : recording?.sourceClaims.find((claim) => claim.provider === 'discogs') ?? null
  const releaseId = item ? releaseIdFromClaim(discogsClaim, item) : null
  const localClaims = recording?.sourceClaims.filter((claim) => claim.provider !== 'discogs').length ?? 0
  const trackPosition = discogsClaim?.trackPosition ?? item?.tags?.discogsTrackPosition ?? null
  const fileDuration = analysis?.durationSeconds ?? null
  const recordDuration = recording?.durationSeconds ?? chosenClaim?.durationSeconds ?? null
  const { data: discogsRelease, error: discogsError, isPending: isDiscogsLoading } = useQuery({
    queryKey: ['discogs-release', releaseId],
    queryFn: () => api.onlineSearch.getDiscogsEntity('release', releaseId as number),
    enabled: releaseId != null
  })
  const isDiscogsReleaseLoading = releaseId != null && isDiscogsLoading
  const discogsTitle = discogsClaim?.title ?? item?.tags?.title
  const titleNeedle = normalize(discogsTitle)
  const officialTrack = findDiscogsDisplayTrack(
    discogsRelease?.tracklist ?? [],
    trackPosition,
    discogsTitle,
    item?.upgradeCase?.officialDurationSeconds ?? item?.upgradeCase?.referenceDurationSeconds ?? null
  )
  const trackDuration = officialTrack?.duration ? parseDurationString(officialTrack.duration) : null
  const videoDuration = titleNeedle
    ? discogsRelease?.videos.find((video) => normalize(video.title).includes(titleNeedle))?.duration ?? null
    : null
  const discogsDuration = trackDuration ?? videoDuration ?? discogsClaim?.durationSeconds ?? null
  const discogsSource = trackDuration != null ? 'Discogs tracklist' : videoDuration != null ? 'Discogs video' : discogsError ? 'Release load error' : discogsClaim ? 'stored claim' : '-'
  const tagRepairRows = item ? buildTagRepairRows(item.tags, recording?.canonical ?? item.recordingCanonical) : []
  const heading = buildCollectionItemHeading(item, recording, officialTrack)

  const handleSync = useCallback(async (): Promise<void> => {
    setBusyAction('sync')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.syncNow()
      await refetch()
      setActionMessage('Collection synced.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to sync collection'))
    } finally {
      setBusyAction(null)
    }
  }, [refetch])

  const handleReanalyze = useCallback(async (): Promise<void> => {
    if (!item) return
    setBusyAction('reanalyze')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.reanalyze(item.filename)
      await refetch()
      setActionMessage('Reanalysis completed.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to reanalyze'))
    } finally {
      setBusyAction(null)
    }
  }, [item, refetch])

  const handleIdentify = useCallback(async (): Promise<void> => {
    if (!item) return
    setBusyAction('identify')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.queueIdentificationProcessing([item.filename], true)
      await refetch()
      setActionMessage('Identification refresh queued.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to queue identification'))
    } finally {
      setBusyAction(null)
    }
  }, [item, refetch])

  const handleFindDiscogs = useCallback(async (): Promise<void> => {
    if (!item) return
    setBusyAction('discogs')
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.identifyWithExternalSources(item.filename)
      await refetch()
      setActionMessage('Discogs candidates refreshed. Review Identify to accept one.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to search Discogs'))
    } finally {
      setBusyAction(null)
    }
  }, [item, refetch])

  const handleRequestUpgrade = useCallback(async (): Promise<void> => {
    if (!item) return
    setBusyAction('upgrade')
    setActionMessage(null)
    setActionError(null)
    try {
      const existing = (await api.wantList.list()).find(
        (want) => want.wantKind === 'replacement' && want.sourceCollectionFilename === item.filename
      )
      const want = existing ?? await api.wantList.add(buildReplacementWantInput(item))
      navigate(`/wantlist/${want.id}`)
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to request upgrade'))
    } finally {
      setBusyAction(null)
    }
  }, [item, navigate])

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
        await refetch()
        setActionMessage(action === 'reject' ? 'Candidate rejected.' : 'Identification updated.')
      } catch (error) {
        setActionError(getErrorMessage(error, 'Failed to update identification'))
      } finally {
        setBusyCandidateId(null)
      }
    },
    [item, refetch]
  )

  const handleRepairTag = useCallback(async (field: TagRepairField): Promise<void> => {
    if (!item) return
    setBusyTagField(field)
    setActionMessage(null)
    setActionError(null)
    try {
      await api.collection.repairTags(item.filename, [field])
      await refetch()
      setActionMessage('ID3 tag updated.')
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to write ID3 tag'))
    } finally {
      setBusyTagField(null)
    }
  }, [item, refetch])

  return (
    <div className="space-y-3">
      <PageHeader
        title={heading.title}
        subtitle={heading.subtitle || itemLabel || 'Missing collection item.'}
        actions={
          <>
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
                <ActionButton size="xs" onClick={() => void api.collection.openInPlayer(item.filename)}>
                  Open Player
                </ActionButton>
                <ActionButton size="xs" disabled={busyAction === 'reanalyze'} title="Recompute audio/hash analysis for this file" onClick={() => void handleReanalyze()}>
                  {busyAction === 'reanalyze' ? 'Reanalyzing…' : 'Reanalyze'}
                </ActionButton>
                <ActionButton size="xs" disabled={busyAction === 'identify'} onClick={() => void handleIdentify()}>
                  {busyAction === 'identify' ? 'Queuing…' : 'Reidentify'}
                </ActionButton>
                <ActionButton size="xs" disabled={busyAction === 'discogs'} onClick={() => void handleFindDiscogs()}>
                  {busyAction === 'discogs' ? 'Searching...' : 'Find Discogs'}
                </ActionButton>
                <ActionButton size="xs" tone="primary" onClick={() => setShowDiscogsAssign(true)}>
                  Assign Discogs
                </ActionButton>
                <ActionButton size="xs" onClick={() => navigate(buildIdentifyReviewHref(item.filename, item.isDownload ? 'downloads' : 'collection'))}>
                  Review Identify
                </ActionButton>
                {!item.isDownload ? (
                  <ActionButton size="xs" tone="primary" disabled={busyAction === 'upgrade'} onClick={() => void handleRequestUpgrade()}>
                    {busyAction === 'upgrade' ? 'Requesting...' : 'Request Upgrade'}
                  </ActionButton>
                ) : null}
                <ActionButton size="xs" disabled={busyAction === 'sync'} onClick={() => void handleSync()}>
                  {busyAction === 'sync' ? 'Rescanning…' : 'Rescan'}
                </ActionButton>
              </>
            ) : null}
          </>
        }
      />

      {isLoading ? <Notice className="text-sm">Loading item…</Notice> : null}
      {errorMessage ? <Notice tone="error" className="text-sm">{errorMessage}</Notice> : null}
      {actionError ? <Notice tone="error" className="text-sm">{actionError}</Notice> : null}
      {actionMessage ? <Notice tone="success" className="text-sm">{actionMessage}</Notice> : null}
      {!isLoading && itemLabel && !item && !errorMessage ? (
        <Notice tone="warning" className="text-sm">Item not found in collection.</Notice>
      ) : null}

      {item ? (
        <>
        <div className="flex flex-row flex-wrap gap-6">
          <ViewSection title="File Info">
              <KV
                labelWidth="72px"
                rows={[
                  { label: 'Format', value: `${analysis?.format ?? '-'}${analysis?.codec ? ` / ${analysis.codec}` : ''}` },
                  { label: 'Size', value: formatFileSize(item.filesize) },
                  { label: 'Modified', value: fmtDate(item.mtimeMs) },
                  { label: 'Duration', value: duration(fileDuration) },
                  { label: 'Bitrate', value: analysis?.bitrateKbps ? `${analysis.bitrateKbps} kbps` : '-' },
                  { label: 'Sample Rate', value: analysis?.sampleRateHz ? `${analysis.sampleRateHz} Hz` : '-' },
                // add quality overall score
                ]}
              />
              </ViewSection>
              <ViewSection title="Discogs">
                <KV
                  labelWidth="76px"
                  rows={[
                    { label: 'Release', value: releaseId ? <span className="inline-flex items-center gap-1">{discogsRelease?.title ?? discogsClaim?.releaseTitle ?? releaseId}<SourceIconLink url={buildDiscogsReleaseUrl(releaseId)} label="Open Discogs release" /></span> : '-' },
                  ]}
                />
                {discogsRelease ? (
                  <DiscogsReleaseTracklist
                    tracks={discogsRelease.tracklist}
                    assignedPosition={officialTrack?.position ?? trackPosition}
                    assignedTitle={officialTrack?.title ?? discogsClaim?.title ?? item.tags?.title ?? null}
                  />
                ) : null}
              </ViewSection>
              <ViewSection title="Data Quality">
                <KV
                  labelWidth="76px"
                  rows={[
                    { label: 'Duration drift', value: drift(fileDuration, discogsDuration) },
                    ...tagRepairRows.map((row) => ({
                      label: row.label,
                      value: <TagRepairValue row={row} busy={busyTagField === row.field} onRepair={(field) => void handleRepairTag(field)} />
                    })),
                  ]}
                />
              </ViewSection>
          </div>

        </>
      ) : null}
      {item && showDiscogsAssign ? (
        <DiscogsTrackAssignDialog
          filename={item.filename}
          initialQuery={discogsSearchQuery(item, summary)}
          onClose={() => setShowDiscogsAssign(false)}
          onAssigned={async () => { await refetch() }}
        />
      ) : null}
    </div>
  )
}

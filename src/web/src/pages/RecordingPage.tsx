import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { KV } from '../components/view/KV'
import { Notice } from '../components/view/Notice'
import { ViewSection } from '../components/view/ViewSection'
import { localFileUrl, usePlayer } from '../context/PlayerContext'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { formatCompactDuration } from '../lib/music-file'
import { buildCollectionItemHref, buildDiscogsReleaseUrl, buildIdentifyReviewHref, buildMusicBrainzRecordingUrl } from '../lib/urls'
import { VideoSection } from './discogs-shared'

function titleForRecording(recording: NonNullable<Awaited<ReturnType<typeof api.collection.getRecording>>>): string {
  const title = [recording.canonical.artist, recording.canonical.title].filter(Boolean).join(' - ')
  return `${title || `Recording ${recording.id}`}${recording.canonical.version ? ` (${recording.canonical.version})` : ''}${recording.canonical.year ? ` · ${recording.canonical.year}` : ''}`
}

export default function RecordingPage(): React.JSX.Element {
  const navigate = useNavigate()
  const player = usePlayer()
  const actions = useAsyncAction()
  const { recordingId } = useParams<{ recordingId: string }>()
  const id = Number(recordingId)
  const { data: recording, isPending, error, refetch } = useQuery({
    queryKey: ['collection', 'recording', id],
    queryFn: () => api.collection.getRecording(id),
    enabled: Number.isInteger(id) && id > 0
  })
  const [draft, setDraft] = useState({ artist: '', title: '', version: '', year: '' })
  useEffect(() => {
    setDraft({
      artist: recording?.canonical.artist ?? '',
      title: recording?.canonical.title ?? '',
      version: recording?.canonical.version ?? '',
      year: recording?.canonical.year ?? ''
    })
  }, [recording?.id, recording?.canonical.artist, recording?.canonical.title, recording?.canonical.version, recording?.canonical.year])
  const discogsReleaseId = useMemo(() => {
    const key = recording?.sourceClaims.find((claim) => claim.provider === 'discogs' && claim.externalKey.startsWith('discogs:release:'))?.externalKey
    const match = key?.match(/^discogs:release:(\d+)/i)
    return match ? Number(match[1]) : null
  }, [recording])
  const { data: discogsRelease } = useQuery({
    queryKey: ['discogs', 'release', discogsReleaseId],
    queryFn: () => api.onlineSearch.getDiscogsEntity('release', discogsReleaseId!),
    enabled: typeof discogsReleaseId === 'number' && discogsReleaseId > 0
  })
  const errorMessage = error instanceof Error ? error.message : error ? 'Failed to load recording' : null
  const saveCanonical = (): void => {
    if (!recording) return
    void actions.run({
      key: 'save-recording',
      action: async () => {
        await api.collection.updateRecording(recording.id, draft)
        await refetch()
      },
      successMessage: 'Recording updated.',
      errorFallback: 'Failed to update recording'
    })
  }
  const assignSourceForRecord = (sourceClaimId: number): void => {
    if (!recording) return
    void actions.run({
      key: `use-source-${sourceClaimId}`,
      action: async () => {
        await api.collection.updateRecording(recording.id, {}, sourceClaimId)
        await refetch()
      },
      successMessage: 'Recording updated from source.',
      errorFallback: 'Failed to use source for recording'
    })
  }

  return (
    <div className="space-y-4">
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      {actions.errorMessage ? <Notice tone="error">{actions.errorMessage}</Notice> : null}
      {actions.actionMessage ? <Notice tone="success">{actions.actionMessage}</Notice> : null}
      {isPending ? <Notice>Loading…</Notice> : null}
      {!isPending && !recording && !errorMessage ? <Notice tone="warning">Recording not found.</Notice> : null}
      {recording ? (
        <>
          <ViewSection title={titleForRecording(recording)} subtitle={`Recording ${recording.id}`}>
            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                <input value={draft.artist} onChange={(event) => setDraft((current) => ({ ...current, artist: event.target.value }))} placeholder="Artist" className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
                <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Title" className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
                <input value={draft.version} onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} placeholder="Version" className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
                <input value={draft.year} onChange={(event) => setDraft((current) => ({ ...current, year: event.target.value }))} placeholder="Year" className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton size="sm" tone="primary" disabled={actions.busyAction === 'save-recording'} onClick={saveCanonical}>
                  {actions.busyAction === 'save-recording' ? 'Saving…' : 'Save Recording'}
                </ActionButton>
                <span className="text-xs text-zinc-500">Length {formatCompactDuration(recording.durationSeconds)}</span>
              </div>
              <KV
                rows={[
                  { label: 'Confidence', value: recording.confidence },
                  { label: 'Review', value: recording.reviewState },
                  { label: 'Locked', value: recording.metadataLocked ? 'yes' : 'no' },
                  { label: 'Merged Into', value: recording.mergedIntoRecordingId ?? '—' },
                  { label: 'Files', value: recording.fileCount },
                  { label: 'Claims', value: recording.claimCount }
                ]}
              />
            </div>
          </ViewSection>
          <ViewSection title="Files" padding="sm">
            <div className="space-y-1 text-sm">
              {recording.files.map((file) => (
                <div key={file.filename} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ActionButton
                    size="xs"
                    tone={player.track?.filename === file.filename && player.isPlaying ? 'primary' : 'default'}
                    onClick={() =>
                      player.play({
                        url: localFileUrl('', file.filename),
                        filename: file.filename,
                        title: recording.canonical.title ?? file.filename,
                        artist: recording.canonical.artist ?? ''
                      })
                    }
                  >
                    {player.track?.filename === file.filename && player.isPlaying ? 'Pause' : 'Play'}
                  </ActionButton>
                  <Link to={buildCollectionItemHref(file.id)} className="text-zinc-200 hover:text-zinc-50">
                    {file.filename}
                  </Link>
                  <ActionButton size="xs" onClick={() => navigate(buildIdentifyReviewHref(file.id, file.filename.includes('to_organize/') ? 'downloads' : 'collection'))}>
                    Identify
                  </ActionButton>
                  <span className="text-zinc-500">{file.status}</span>
                  <span className="text-zinc-500">{file.assignmentMethod ?? '—'}</span>
                  <span className="text-zinc-500">{file.confidence ?? '—'}</span>
                </div>
              ))}
            </div>
          </ViewSection>
          {discogsRelease ? <VideoSection videos={discogsRelease.videos} /> : null}
          <ViewSection title="Source Claims" padding="sm">
            {!recording.sourceClaims.length ? (
              <Notice tone="warning">
                No sources yet.
                {recording.files[0] ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="text-zinc-100 underline underline-offset-2 hover:text-zinc-50"
                      onClick={() => navigate(buildIdentifyReviewHref(recording.files[0].id, recording.files[0].filename.includes('to_organize/') ? 'downloads' : 'collection'))}
                    >
                      Open identify
                    </button>
                  </>
                ) : null}
              </Notice>
            ) : null}
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-zinc-950/50 text-zinc-500">
                  <tr>
                    <th className="w-[1%] whitespace-nowrap px-2 py-1.5 font-medium">Source</th>
                    <th className="px-2 py-1.5 font-medium">Artist</th>
                    <th className="px-2 py-1.5 font-medium">Title</th>
                    <th className="px-2 py-1.5 font-medium">Version</th>
                    <th className="px-2 py-1.5 font-medium">Release</th>
                    <th className="px-2 py-1.5 font-medium">Year</th>
                    <th className="px-2 py-1.5 font-medium">Length</th>
                    <th className="w-[1%] whitespace-nowrap px-2 py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {recording.sourceClaims.map((claim) => {
                    const externalUrl =
                      claim.provider === 'discogs' && claim.externalKey.startsWith('discogs:release:')
                        ? buildDiscogsReleaseUrl(claim.externalKey.split(':')[2])
                        : claim.provider === 'musicbrainz' && claim.externalKey.startsWith('musicbrainz:recording:')
                          ? buildMusicBrainzRecordingUrl(claim.externalKey.split(':')[2])
                          : null
                    return (
                      <tr key={claim.id} className="border-t border-zinc-800">
                        <td className="whitespace-nowrap px-2 py-1.5 align-top">
                          <div className="flex items-center gap-1.5">
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300">
                              {claim.provider}
                            </span>
                            <span className="text-zinc-500">{claim.entityType}</span>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 align-top text-zinc-100">{claim.artist ?? '—'}</td>
                        <td className="px-2 py-1.5 align-top text-zinc-100">{claim.title ?? '—'}</td>
                        <td className="px-2 py-1.5 align-top text-zinc-300">{claim.version ?? '—'}</td>
                        <td className="px-2 py-1.5 align-top text-zinc-300">
                          {[claim.releaseTitle, claim.trackPosition].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-2 py-1.5 align-top text-zinc-300">{claim.year ?? '—'}</td>
                        <td className="px-2 py-1.5 align-top text-zinc-300">{formatCompactDuration(claim.durationSeconds)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 align-top">
                          <div className="flex items-center gap-2">
                            <ActionButton
                              size="xs"
                              disabled={actions.busyAction === `use-source-${claim.id}`}
                              onClick={() => assignSourceForRecord(claim.id)}
                            >
                              {actions.busyAction === `use-source-${claim.id}` ? 'Updating…' : 'Use For Record'}
                            </ActionButton>
                            {externalUrl ? <a className="text-zinc-400 hover:text-zinc-200" href={externalUrl} target="_blank" rel="noreferrer">Open</a> : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </ViewSection>
        </>
      ) : null}
    </div>
  )
}

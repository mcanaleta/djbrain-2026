import type { CollectionItemDetails, RecordingDetails } from '../../../../shared/api'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { parseDurationString } from '../../../../shared/track-matcher'
import { api } from '../../api/client'
import { KV } from '../../components/view/KV'
import { Pill } from '../../components/view/Pill'
import { SourceIconLink } from '../../components/view/SourceIconLink'
import { ViewSection } from '../../components/view/ViewSection'
import { buildDiscogsReleaseUrl } from '../../lib/urls'
import { formatCompactDuration, formatFileSize } from '../../lib/music-file'

type SourceClaim = RecordingDetails['sourceClaims'][number]

function fmtDate(value: string | number | null | undefined): string {
  if (value == null) return '-'
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

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

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function Step({
  title,
  status,
  children
}: {
  title: string
  status?: string
  children: ReactNode
}): React.JSX.Element {
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

export function CollectionItemModelView({
  item,
  recording,
  isRecordingLoading
}: {
  item: CollectionItemDetails
  recording: RecordingDetails | null | undefined
  isRecordingLoading: boolean
}): React.JSX.Element {
  const hash = item.fileAudioState?.audioHash ?? item.identification?.audioHash ?? null
  const analysis = item.parsedAudioAnalysis
  const discogsClaim = recording?.sourceClaims.find((claim) => claim.provider === 'discogs') ?? null
  const releaseId = releaseIdFromClaim(discogsClaim, item)
  const localClaims = recording?.sourceClaims.filter((claim) => claim.provider !== 'discogs').length ?? 0
  const trackPosition = discogsClaim?.trackPosition ?? item.tags?.discogsTrackPosition ?? null
  const chosenClaim = recording?.sourceClaims.find((claim) => claim.id === item.identification?.chosenClaimId) ?? null
  const fileDuration = analysis?.durationSeconds ?? null
  const recordDuration = recording?.durationSeconds ?? chosenClaim?.durationSeconds ?? null
  const { data: discogsRelease, error: discogsError, isPending: isDiscogsLoading } = useQuery({
    queryKey: ['discogs-release', releaseId],
    queryFn: () => api.onlineSearch.getDiscogsEntity('release', releaseId as number),
    enabled: releaseId != null
  })
  const discogsTitle = discogsClaim?.title ?? item.tags?.title
  const titleNeedle = normalize(discogsTitle)
  const officialTrack = discogsRelease?.tracklist.find((track) => normalize(track.position) === normalize(trackPosition))
    ?? discogsRelease?.tracklist.find((track) => normalize(track.title) === titleNeedle)
    ?? null
  const trackDuration = officialTrack?.duration ? parseDurationString(officialTrack.duration) : null
  const videoDuration = titleNeedle
    ? discogsRelease?.videos.find((video) => normalize(video.title).includes(titleNeedle))?.duration ?? null
    : null
  const discogsDuration = trackDuration ?? videoDuration ?? discogsClaim?.durationSeconds ?? null
  const discogsSource = trackDuration != null ? 'Discogs tracklist' : videoDuration != null ? 'Discogs video' : discogsError ? 'Release load error' : discogsClaim ? 'stored claim' : '-'

  return (
    <ViewSection title="Identity Chain" subtitle="File -> audio hash -> record -> optional external source." padding="sm">
      <div className="grid gap-3 md:grid-cols-4">
        <Step title="File" status={item.isDownload ? 'download' : 'song'}>
          <KV
            labelWidth="72px"
            rows={[
              { label: 'Path', value: item.filename },
              { label: 'Format', value: `${analysis?.format ?? '-'}${analysis?.codec ? ` / ${analysis.codec}` : ''}` },
              { label: 'Tags', value: tagSummary(item) },
              { label: 'Release', value: tagRelease(item) },
              { label: 'Size', value: formatFileSize(item.filesize) },
              { label: 'Modified', value: fmtDate(item.mtimeMs) }
            ]}
          />
        </Step>
        <Step title="Hash" status={item.fileAudioState?.status ?? 'missing'}>
          <KV
            labelWidth="72px"
            rows={[
              { label: 'Audio', value: <span title={hash ?? ''}>{shortHash(hash)}</span> },
              { label: 'Duration', value: duration(fileDuration) },
              { label: 'Bitrate', value: analysis?.bitrateKbps ? `${analysis.bitrateKbps} kbps` : '-' },
              { label: 'Rate', value: analysis?.sampleRateHz ? `${analysis.sampleRateHz} Hz` : '-' },
              { label: 'Loudness', value: analysis?.integratedLufs != null ? `${analysis.integratedLufs} LUFS` : '-' }
            ]}
          />
        </Step>
        <Step title="Record" status={item.identificationStatus ?? 'missing'}>
          <KV
            labelWidth="82px"
            rows={[
              { label: 'ID', value: item.recordingId ?? '-' },
              { label: 'Canonical', value: modelTitle(recording, item) },
              { label: 'Duration', value: duration(recordDuration) },
              { label: 'Drift', value: drift(fileDuration, recordDuration) },
              { label: 'Method', value: item.assignmentMethod ?? '-' },
              { label: 'Confidence', value: item.identificationConfidence ?? recording?.confidence ?? '-' }
            ]}
          />
          {isRecordingLoading ? <div className="mt-1 text-[11px] text-zinc-500">Loading record...</div> : null}
        </Step>
        <Step title="Discogs" status={discogsClaim ? 'linked' : 'optional'}>
          <KV
            labelWidth="76px"
            rows={[
              { label: 'Release', value: releaseId ? <span className="inline-flex items-center gap-1">{releaseId}<SourceIconLink url={buildDiscogsReleaseUrl(releaseId)} label="Discogs release" /></span> : '-' },
              { label: 'Track', value: `${trackPosition ?? '-'}${officialTrack?.position && officialTrack.position !== trackPosition ? ` -> ${officialTrack.position}` : ''}` },
              { label: 'Title', value: discogsClaim?.releaseTitle ?? item.tags?.album ?? '-' },
              { label: 'Duration', value: isDiscogsLoading ? 'Loading...' : duration(discogsDuration) },
              { label: 'Drift', value: drift(fileDuration, discogsDuration) },
              { label: 'Source', value: isDiscogsLoading ? 'Loading...' : discogsSource },
              { label: 'Claims', value: recording ? `${recording.sourceClaims.length} total / ${localClaims} local` : '-' }
            ]}
          />
        </Step>
      </div>
    </ViewSection>
  )
}

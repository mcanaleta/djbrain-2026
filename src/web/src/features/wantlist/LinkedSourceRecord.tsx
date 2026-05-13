import { Link } from 'react-router-dom'
import type { CollectionItemDetails } from '../../../../shared/api'
import { buildCollectionItemPath } from '../../../../shared/collection-url'
import { ActionButton } from '../../components/view/ActionButton'
import { FormatBadge } from '../../components/view/FormatBadge'
import { Notice } from '../../components/view/Notice'
import { Pill } from '../../components/view/Pill'
import { ViewPanel } from '../../components/view/ViewPanel'
import { localFileUrl, usePlayer } from '../../context/PlayerContext'
import {
  deriveTrackSummaryFromFilename,
  fileBasename,
  formatBitrate,
  formatCompactDuration,
  formatExtensionName,
  formatFileSize
} from '../../lib/music-file'

export function LinkedSourceRecord({
  item,
  filename,
  error,
  isLoading,
  onOpenInPlayer,
  onShowInFinder
}: {
  item: CollectionItemDetails | null
  filename: string | null
  error: string | null
  isLoading: boolean
  onOpenInPlayer: (filename: string) => void
  onShowInFinder: (filename: string) => void
}): React.JSX.Element {
  const player = usePlayer()

  if (isLoading) return <Notice>Loading linked record...</Notice>
  if (error) return <Notice tone="error">{error}</Notice>
  if (!item) return <Notice tone="warning">{filename ? `Linked file not found: ${filename}` : 'No linked source record.'}</Notice>

  const fallback = deriveTrackSummaryFromFilename(item.filename)
  const artist = item.recordingCanonical?.artist || item.tags?.artist || fallback.artist
  const title = item.recordingCanonical?.title || item.tags?.title || fallback.title
  const version = item.recordingCanonical?.version || item.tags?.version
  const displayTitle = version ? `${title} (${version})` : title
  const duration = item.parsedAudioAnalysis?.durationSeconds ?? null
  const bitrate = item.parsedAudioAnalysis?.bitrateKbps ?? null
  const isCurrent = player.track?.filename === item.filename

  return (
    <ViewPanel padding="sm" className="flex flex-wrap items-center gap-3">
      <div className="min-w-[240px] flex-1 leading-tight">
        <div className="truncate text-sm font-medium text-zinc-100" title={`${artist} - ${displayTitle}`}>
          {artist} - {displayTitle}
        </div>
        <div className="truncate text-[11px] text-zinc-500" title={item.filename}>
          {fileBasename(item.filename)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <FormatBadge format={formatExtensionName(item.filename)} />
        <Pill>{formatBitrate(bitrate)}</Pill>
        <Pill>{formatCompactDuration(duration)}</Pill>
        <Pill>{formatFileSize(item.filesize)}</Pill>
        {item.recordingId ? <Pill>Recording {item.recordingId}</Pill> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <ActionButton type="button" size="xs" onClick={() => {
          if (isCurrent) { player.toggle(); return }
          player.play({ url: localFileUrl('', item.filename), filename: item.filename, title: displayTitle, artist })
        }}>
          {isCurrent && player.isPlaying ? 'Pause' : 'Play'}
        </ActionButton>
        <ActionButton type="button" size="xs" onClick={() => onShowInFinder(item.filename)}>Reveal</ActionButton>
        <ActionButton type="button" size="xs" onClick={() => onOpenInPlayer(item.filename)}>Open</ActionButton>
        <Link className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800" to={buildCollectionItemPath(item.id, item.filename)}>
          View
        </Link>
      </div>
    </ViewPanel>
  )
}

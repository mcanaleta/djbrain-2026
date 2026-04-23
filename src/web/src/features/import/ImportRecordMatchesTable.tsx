import { PauseIcon, PlayIcon } from '@radix-ui/react-icons'
import type { CollectionItem } from '../../../../shared/api'
import { ActionButton } from '../../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../../components/view/DataTable'
import { Pill } from '../../components/view/Pill'
import { buildRecordingHref } from '../../lib/urls'
import { formatCompactDuration } from '../../lib/music-file'
import { localFileUrl, usePlayer } from '../../context/PlayerContext'

function basename(path: string): string {
  return path.split('/').at(-1) || path
}

function PlayButton({ item }: { item: CollectionItem }): React.JSX.Element {
  const player = usePlayer()
  const isCurrent = player.track?.filename === item.filename
  const isPlaying = isCurrent && player.isPlaying
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        player.play({
          url: localFileUrl('', item.filename),
          filename: item.filename,
          title: item.recordingCanonical?.title ?? item.importTitle ?? item.filename,
          artist: item.recordingCanonical?.artist ?? item.importArtist ?? ''
        })
      }}
      title={isPlaying ? 'Pause' : 'Play'}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${
        isCurrent
          ? 'border-zinc-500 bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
      }`}
    >
      {isPlaying ? <PauseIcon className="h-3 w-3" /> : <PlayIcon className="h-3 w-3" />}
    </button>
  )
}

export function ImportRecordMatchesTable({
  items,
  currentRecordingId,
  busyAction,
  onAnalyze,
  onAssign
}: {
  items: CollectionItem[]
  currentRecordingId: number
  busyAction: string | null
  onAnalyze: (item: CollectionItem) => void
  onAssign: (item: CollectionItem) => void
}): React.JSX.Element {
  const columns: DataTableColumn<CollectionItem>[] = [
    {
      key: 'play',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <PlayButton item={row} />
    },
    {
      key: 'scope',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <Pill tone={row.isDownload ? 'primary' : 'default'}>{row.isDownload ? 'DOWNLOAD' : 'SONG'}</Pill>
    },
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[180px] truncate text-zinc-100',
      render: (row) => row.recordingCanonical?.artist ?? row.importArtist ?? '—'
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[420px] truncate text-zinc-100',
      render: (row) => {
        const title = row.recordingCanonical?.title ?? row.importTitle ?? basename(row.filename)
        const version = row.recordingCanonical?.version ?? row.importVersion
        return <span title={row.filename}>{version ? `${title} (${version})` : title}</span>
      }
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => row.recordingCanonical?.year ?? row.importYear ?? '—'
    },
    {
      key: 'length',
      header: 'Length',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) => formatCompactDuration(row.duration)
    },
    {
      key: 'record',
      header: 'Record',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) =>
        row.recordingId == null ? (
          '—'
        ) : row.recordingId === currentRecordingId ? (
          'This'
        ) : (
          <a
            href={buildRecordingHref(row.recordingId)}
            onClick={(event) => event.stopPropagation()}
            className="text-zinc-300 hover:text-zinc-100"
          >
            #{row.recordingId}
          </a>
        )
    },
    {
      key: 'assign',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => (
        <ActionButton
          size="xs"
          disabled={busyAction === `analyze-${row.filename}`}
          onClick={(event) => {
            event.stopPropagation()
            onAnalyze(row)
          }}
        >
          {busyAction === `analyze-${row.filename}` ? 'Analyzing…' : 'Analyze'}
        </ActionButton>
      )
    },
    {
      key: 'add',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => (
        <ActionButton
          size="xs"
          disabled={busyAction === `assign-${row.filename}` || row.recordingId === currentRecordingId}
          onClick={(event) => {
            event.stopPropagation()
            onAssign(row)
          }}
        >
          {busyAction === `assign-${row.filename}` ? 'Adding…' : row.recordingId === currentRecordingId ? 'Added' : 'Add'}
        </ActionButton>
      )
    }
  ]

  return (
    <DataTable
      columns={columns}
      rows={items}
      getRowKey={(row) => String(row.id)}
      getRowTitle={(row) => row.filename}
      emptyMessage="No similar local matches."
      tableClassName="min-w-[1120px]"
      borderless
      className="rounded-none bg-transparent"
    />
  )
}

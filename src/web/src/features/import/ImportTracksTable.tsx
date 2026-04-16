import { PauseIcon, PlayIcon } from '@radix-ui/react-icons'
import { DataTable, type DataTableColumn } from '../../components/view/DataTable'
import { Pill } from '../../components/view/Pill'
import { SourceLinks } from '../../components/view/SourceLinks'
import { ViewSection } from '../../components/view/ViewSection'
import { localFileUrl, usePlayer } from '../../context/PlayerContext'
import { fileBasename } from '../../lib/music-file'
import type { ImportTracksTableRow } from './importRows'

function ImportTrackPlayButton({
  row,
  musicFolderPath
}: {
  row: ImportTracksTableRow
  musicFolderPath: string
}): React.JSX.Element {
  const player = usePlayer()
  const isCurrentTrack = player.track?.filename === row.bestFile.filename
  const isPlaying = isCurrentTrack && player.isPlaying

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        if (!musicFolderPath) return
        player.play({
          url: localFileUrl(musicFolderPath, row.bestFile.filename),
          filename: row.bestFile.filename,
          title: row.bestFile.title,
          artist: row.bestFile.artist
        })
      }}
      disabled={!musicFolderPath}
      title={isPlaying ? 'Pause' : 'Play'}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:opacity-30 ${
        isCurrentTrack
          ? 'border-zinc-500 bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
      }`}
    >
      {isPlaying ? <PauseIcon className="h-3 w-3" /> : <PlayIcon className="h-3 w-3" />}
    </button>
  )
}

export function ImportTracksTable({
  rows,
  loading,
  musicFolderPath,
  onOpenRow
}: {
  rows: ImportTracksTableRow[]
  loading: boolean
  musicFolderPath: string
  onOpenRow: (row: ImportTracksTableRow) => void
}): React.JSX.Element {
  const player = usePlayer()
  const columns: DataTableColumn<ImportTracksTableRow>[] = [
    {
      key: 'play',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => <ImportTrackPlayButton row={row} musicFolderPath={musicFolderPath} />
    },
    {
      key: 'track',
      header: 'Track',
      cellClassName: 'max-w-[360px] truncate text-zinc-100',
      render: (row) => (
        <div>
          <div title={`${row.artist} - ${row.title}`}>{row.artist} - {row.title}</div>
          <div className="truncate text-zinc-500" title={row.releaseTitle ?? row.bestFile.filename}>
            {row.releaseTitle ?? fileBasename(row.bestFile.filename)}
          </div>
          <SourceLinks discogsUrl={row.bestFile.recordingDiscogsUrl} musicBrainzUrl={row.bestFile.recordingMusicBrainzUrl} />
        </div>
      )
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-400',
      render: (row) => row.year
    },
    {
      key: 'files',
      header: 'Files',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) => row.fileCount
    },
    {
      key: 'replace',
      header: 'Replace',
      cellClassName: 'max-w-[260px] truncate text-zinc-300',
      render: (row) =>
        row.replacementFilename ? (
          <div>
            <Pill tone="primary">replace</Pill>
            <div className="mt-1 truncate text-zinc-500" title={row.replacementFilename}>
              {row.replacementFilename}
            </div>
          </div>
        ) : (
          '—'
        )
    },
    {
      key: 'better',
      header: 'Better',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) =>
        row.betterQualityFound === true ? (
          <Pill tone="success">better found</Pill>
        ) : row.betterQualityFound === false ? (
          <Pill>no</Pill>
        ) : (
          '—'
        )
    },
    {
      key: 'best',
      header: 'Best File',
      cellClassName: 'max-w-[240px] truncate text-zinc-300',
      render: (row) => <span title={row.bestFile.filename}>{fileBasename(row.bestFile.filename)}</span>
    },
    {
      key: 'prep',
      header: 'Prep',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) => row.prep
    }
  ]

  return (
    <ViewSection borderless className="p-0" bodyClassName="mt-0">
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.key}
        loading={loading}
        loadingMessage="Loading…"
        emptyMessage="No tracks in configured download folders. Update env and sync."
        onRowClick={onOpenRow}
        tableClassName="min-w-[1120px]"
        rowClassName={(row) =>
          player.track?.filename === row.bestFile.filename ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/20'
        }
        borderless
        className="rounded-none bg-transparent"
      />
    </ViewSection>
  )
}

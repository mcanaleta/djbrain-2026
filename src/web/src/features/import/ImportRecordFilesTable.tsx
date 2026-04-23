import { PauseIcon, PlayIcon } from '@radix-ui/react-icons'
import type { RecordingDetails } from '../../../../shared/api'
import { ActionButton } from '../../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../../components/view/DataTable'
import { Pill } from '../../components/view/Pill'
import { localFileUrl, usePlayer } from '../../context/PlayerContext'
import { IMPORT_FILE_METRICS, MetricValueCell, formatImportMetric, formatLengthWithDeviation, lengthDeviationBar, metricBar } from './importQuality'

type RecordingFile = RecordingDetails['files'][number]

function basename(path: string): string {
  return path.split('/').at(-1) || path
}

function PlayButton({ file }: { file: RecordingFile }): React.JSX.Element {
  const player = usePlayer()
  const isCurrent = player.track?.filename === file.filename
  const isPlaying = isCurrent && player.isPlaying
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        player.play({
          url: localFileUrl('', file.filename),
          filename: file.filename,
          title: file.filename,
          artist: ''
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

function SelectButton({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`inline-flex min-w-8 items-center justify-center rounded border px-1.5 py-0.5 text-[10px] ${
        active ? 'border-amber-700/50 bg-amber-950/20 text-amber-200' : 'border-zinc-700 bg-zinc-950/40 text-zinc-400'
      }`}
    >
      {label}
    </button>
  )
}

export function ImportRecordFilesTable({
  files,
  referenceDurationSeconds,
  compareLeftFilename,
  compareRightFilename,
  busyAction,
  onSelectCompareLeft,
  onSelectCompareRight,
  onAnalyze,
  onTranscode,
  onDelete
}: {
  files: RecordingFile[]
  referenceDurationSeconds: number | null
  compareLeftFilename: string | null
  compareRightFilename: string | null
  busyAction: string | null
  onSelectCompareLeft: (filename: string) => void
  onSelectCompareRight: (filename: string) => void
  onAnalyze: (filename: string) => void
  onTranscode: (filename: string) => void
  onDelete: (filename: string) => void
}): React.JSX.Element {
  const columns: DataTableColumn<RecordingFile>[] = [
    {
      key: 'play',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <PlayButton file={row} />
    },
    {
      key: 'a',
      header: 'A',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <SelectButton active={row.filename === compareLeftFilename} label="A" onClick={() => onSelectCompareLeft(row.filename)} />
    },
    {
      key: 'b',
      header: 'B',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <SelectButton active={row.filename === compareRightFilename} label="B" onClick={() => onSelectCompareRight(row.filename)} />
    },
    {
      key: 'scope',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <Pill tone={row.isDownload ? 'primary' : 'default'}>{row.isDownload ? 'DOWNLOAD' : 'SONG'}</Pill>
    },
    {
      key: 'file',
      header: 'File',
      cellClassName: 'max-w-[680px] truncate text-zinc-100',
      render: (row) => <span title={row.filename}>{basename(row.filename)}</span>
    },
    {
      key: 'status',
      header: 'Status',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => row.status
    },
    {
      key: 'verified',
      header: 'Verified',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) => (row.verifiedAt ? 'yes' : '—')
    },
    {
      key: 'analyze',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => (
        <ActionButton
          size="xs"
          disabled={busyAction === `analyze-${row.filename}`}
          onClick={(event) => {
            event.stopPropagation()
            onAnalyze(row.filename)
          }}
        >
          {busyAction === `analyze-${row.filename}` ? 'Analyzing…' : 'Analyze'}
        </ActionButton>
      )
    },
    {
      key: 'transcode',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) =>
        row.filename.toLowerCase().endsWith('.mp3') ? null : (
          <ActionButton
            size="xs"
            disabled={busyAction === `transcode-${row.filename}`}
            onClick={(event) => {
              event.stopPropagation()
              onTranscode(row.filename)
            }}
          >
            {busyAction === `transcode-${row.filename}` ? 'Converting…' : '320 MP3'}
          </ActionButton>
        )
    },
    {
      key: 'delete',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) =>
        row.isDownload ? (
          <ActionButton
            size="xs"
            tone="danger"
            disabled={busyAction === `delete-${row.filename}`}
            onClick={(event) => {
              event.stopPropagation()
              onDelete(row.filename)
            }}
          >
            {busyAction === `delete-${row.filename}` ? 'Deleting…' : 'Delete'}
          </ActionButton>
        ) : null
    }
  ]
  columns.splice(
    columns.length - 1,
    0,
    ...IMPORT_FILE_METRICS.map<DataTableColumn<RecordingFile>>((key) => ({
      key,
      header: key === 'quality' ? 'Q' : key === 'bitrate' ? 'kbps' : key === 'topend' ? 'TOP' : key.toUpperCase(),
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => (
        <MetricValueCell
          value={
            key === 'len'
              ? formatLengthWithDeviation(row.duration, referenceDurationSeconds)
              : formatImportMetric(key, row.audioAnalysis, {
                  duration: row.duration,
                  filesize: row.filesize,
                  qualityScore: row.qualityScore,
                  bitrateKbps: row.bitrateKbps,
                  filename: row.filename
                })
          }
          bar={key === 'len' ? lengthDeviationBar(row.duration, referenceDurationSeconds) : metricBar(key, row.audioAnalysis)}
        />
      )
    }))
  )

  return (
    <DataTable
      columns={columns}
      rows={files}
      getRowKey={(row) => String(row.id)}
      rowClassName={(row) =>
        row.filename === compareLeftFilename || row.filename === compareRightFilename ? 'bg-zinc-800/30' : ''
      }
      emptyMessage="No files on this record."
      tableClassName="min-w-[1820px]"
      borderless
      className="rounded-none bg-transparent"
    />
  )
}

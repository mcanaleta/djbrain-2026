import type { CollectionItemDetails } from '@djbrain/shared/api'
import { ActionButton } from '../../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../../components/view/DataTable'
import { Pill } from '../../components/view/Pill'
import { QualityBadge } from '../../components/view/QualityBadge'
import { SectionKicker } from '../../components/view/SectionKicker'
import { localFileUrl } from '../../context/PlayerContext'
import { fileBasename, formatCompactDuration, formatFileSize, formatQualityScore } from '../../lib/music-file'
import { AUDIO_QUALITY_MARKERS, AudioQualityMarkerCell } from './AudioQualityMarkers'
import { ImportRecordFileMenu, type ImportRecordFileUtilityAction } from './ImportRecordFileMenu'
import { buildImportRecordFileRows, getImportRecordDownloadActions, type ImportRecordDownloadAction, type ImportRecordFileRow } from './importRecordFiles'
import type { ImportTracksTableRow } from './importRows'
import { useImportRecordMixer } from './useImportRecordMixer'

const mixButtonClass = (active: boolean, activeClass: string): string =>
  `inline-flex h-7 w-7 items-center justify-center rounded border text-[10px] font-bold ${active ? activeClass : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'}`
const ACTION_LABEL = { import: 'Import', replace: 'Replace', delete: 'Delete' } satisfies Record<ImportRecordDownloadAction, string>
const BUSY_ACTION_LABEL = { import: 'Importing...', replace: 'Replacing...', delete: 'Deleting...' } satisfies Record<ImportRecordDownloadAction, string>
const UTILITY_BUSY_LABEL = { reanalyze: 'Reanalyzing...', show: 'Opening folder...', open: 'Opening...' } satisfies Record<ImportRecordFileUtilityAction, string>

function utilityBusyLabel(busyAction: string | null, row: ImportRecordFileRow): string | null {
  for (const action of Object.keys(UTILITY_BUSY_LABEL) as ImportRecordFileUtilityAction[]) {
    if (busyAction === `${action}:${row.filename}`) return UTILITY_BUSY_LABEL[action]
  }
  return null
}

export function ImportRecordFilesTable({
  record,
  collectionTarget,
  selectedFilename,
  busyAction,
  pendingDeleteFilename,
  onAction,
  onUtilityAction,
  onCancelDelete,
  onSelect
}: {
  record: ImportTracksTableRow
  collectionTarget: CollectionItemDetails | null
  selectedFilename: string | null
  busyAction: string | null
  pendingDeleteFilename: string | null
  onAction: (action: ImportRecordDownloadAction, row: ImportRecordFileRow) => void
  onUtilityAction: (action: ImportRecordFileUtilityAction, row: ImportRecordFileRow) => void
  onCancelDelete: () => void
  onSelect: (filename: string) => void
}): React.JSX.Element {
  const rows = buildImportRecordFileRows(record, collectionTarget)
  const hasCollectionTarget = Boolean(collectionTarget)
  const mixer = useImportRecordMixer(rows.map((row) => ({ filename: row.filename, duration: row.duration })))
  const columns: DataTableColumn<ImportRecordFileRow>[] = [
    {
      key: 'mix',
      header: 'Solo',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => {
        const isSolo = mixer.solo.has(row.filename) && mixer.playing.has(row.filename)
        return (
          <button
            type="button"
            title={isSolo ? 'Stop solo' : 'Solo from needle percent'}
            aria-label={isSolo ? 'Stop solo' : 'Solo from needle percent'}
            aria-pressed={isSolo}
            onClick={(event) => {
              event.stopPropagation()
              mixer.toggleSolo(row.filename)
            }}
            className={mixButtonClass(isSolo, 'border-sky-200 bg-sky-300 text-zinc-950')}
          >
            S
          </button>
        )
      }
    },
    {
      key: 'file',
      header: 'File',
      cellClassName: 'max-w-[360px] truncate text-zinc-100',
      render: (row) => (
        <div>
          <div className="flex min-w-0 items-center gap-2">
            <Pill tone={row.kind === 'collection' ? 'primary' : 'muted'}>{row.kind === 'collection' ? 'collection' : 'download'}</Pill>
            <div className="truncate" title={row.filename}>{fileBasename(row.filename)}</div>
          </div>
          <div className="truncate text-[10px] text-zinc-500">{row.filename}</div>
        </div>
      )
    },
    { key: 'len', header: 'Len', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => formatCompactDuration(row.duration) },
    { key: 'size', header: 'Size', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => formatFileSize(row.filesize) },
    ...AUDIO_QUALITY_MARKERS.map(([key, label, description]): DataTableColumn<ImportRecordFileRow> => ({
      key,
      header: <span title={description} aria-label={`${label}: ${description}`} className="cursor-help border-b border-dotted border-zinc-700/70">{label}</span>,
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <AudioQualityMarkerCell marker={key} analysis={row.audioAnalysis ?? null} />
    })),
    {
      key: 'quality',
      header: 'Quality',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => {
        const quality = formatQualityScore(row.qualityScore, row.audioAnalysis?.bitrateKbps)
        return <QualityBadge quality={quality.label} title={quality.title} />
      }
    },
    { key: 'prep', header: 'Prep', cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400', render: (row) => row.prep },
    {
      key: 'actions',
      header: 'Actions',
      cellClassName: 'w-[1%] whitespace-nowrap text-right',
      render: (row) => {
        const utilityBusy = utilityBusyLabel(busyAction, row)
        const menu = <ImportRecordFileMenu row={row} disabled={busyAction !== null} busyLabel={utilityBusy} onAction={onUtilityAction} />
        if (row.kind === 'collection') return <div className="flex justify-end gap-1">{utilityBusy ? <Pill tone="primary" pulse>{utilityBusy}</Pill> : <Pill tone="primary">target</Pill>}{menu}</div>
        const actions = getImportRecordDownloadActions(hasCollectionTarget)
        return (
          <div className="flex justify-end gap-1">
            {utilityBusy ? <Pill tone="primary" pulse>{utilityBusy}</Pill> : null}
            {actions.map((action) => {
              const confirming = action === 'delete' && pendingDeleteFilename === row.filename
              const key = `${action}:${row.filename}`
              const busy = busyAction === key
              return (
                <ActionButton
                  key={action}
                  size="xs"
                  tone={action === 'import' ? 'primary' : action === 'replace' || confirming ? 'danger' : 'default'}
                  className={action === 'delete' ? 'border-rose-700/50 bg-rose-950/20 text-rose-100 hover:bg-rose-950/40' : undefined}
                  disabled={busyAction !== null && !busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    onAction(action, row)
                  }}
                >
                  {busy ? BUSY_ACTION_LABEL[action] : confirming ? 'Confirm' : ACTION_LABEL[action]}
                </ActionButton>
              )
            })}
            {menu}
            {pendingDeleteFilename === row.filename ? (
              <ActionButton size="xs" disabled={busyAction !== null} onClick={(event) => { event.stopPropagation(); onCancelDelete() }}>Cancel</ActionButton>
            ) : null}
          </div>
        )
      }
    }
  ]

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <SectionKicker>Import Record</SectionKicker>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{record.artist} - {record.title}</div>
        </div>
        <Pill>{record.totalFileCount} files</Pill>
      </div>
      <div className="mb-2 flex items-center gap-2 rounded-md border border-zinc-800/70 bg-zinc-900/20 px-2 py-1.5">
        <div className="w-14 text-[10px] uppercase tracking-wide text-zinc-500">Needle</div>
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={mixer.needle}
          onChange={(event) => mixer.seek(Number(event.target.value))}
          className="min-w-[180px] flex-1"
          aria-label="Sync needle"
        />
        <div className="w-12 text-right text-[10px] tabular-nums text-zinc-500">
          {mixer.needle.toFixed(1)}%
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => `${row.kind}:${row.filename}`}
        getRowTitle={(row) => row.filename}
        onRowClick={(row) => { if (row.kind === 'download') onSelect(row.filename) }}
        rowClassName={(row) => row.kind === 'collection' ? 'bg-sky-950/20' : row.filename === selectedFilename ? 'bg-zinc-800/35' : ''}
        tableClassName="min-w-[1420px]"
      />
      <div className="hidden">
        {rows.map((row) => (
          <audio
            key={`${row.kind}:${row.filename}`}
            ref={(element) => mixer.setAudio(row.filename, element)}
            src={localFileUrl('', row.filename)}
            preload="metadata"
            onLoadedMetadata={() => mixer.onLoaded(row.filename)}
            onTimeUpdate={() => mixer.onTime(row.filename)}
            onEnded={() => mixer.onEnded(row.filename)}
          />
        ))}
      </div>
    </div>
  )
}

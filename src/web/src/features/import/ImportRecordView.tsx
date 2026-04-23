import { useState } from 'react'
import type { CollectionItem, RecordingDetails } from '../../../../shared/api'
import { Notice } from '../../components/view/Notice'
import { ViewSection } from '../../components/view/ViewSection'
import { formatCompactDuration } from '../../lib/music-file'
import { ImportRecordActions } from './ImportRecordActions'
import { ImportRecordCompare } from './ImportRecordCompare'
import { ImportRecordDialogs } from './ImportRecordDialogs'
import { ImportRecordDiscogsReleases } from './ImportRecordDiscogsReleases'
import { ImportRecordFilesTable } from './ImportRecordFilesTable'
import { ImportRecordMatchesTable } from './ImportRecordMatchesTable'
import { isRiskyAssign, recordTitle } from './importRecordUtils'

export function ImportRecordView({
  recording,
  similarItems,
  queuePosition,
  queueTotal,
  compareLeftFilename,
  onSelectCompareLeft,
  compareRightFilename,
  onSelectCompareRight,
  busyAction,
  actionMessage,
  errorMessage,
  onAnalyze,
  onTranscode,
  onAssign,
  onDelete,
  replacePair,
  upgradeTargetFilename,
  importSourceFilename,
  needsMp3Conversion,
  onOpenUpgradeCase,
  onReplaceExistingSong,
  onImportSingleDownload,
  onSkipToNext
}: {
  recording: RecordingDetails
  similarItems: CollectionItem[]
  queuePosition: number | null
  queueTotal: number | null
  compareLeftFilename: string | null
  onSelectCompareLeft: (filename: string) => void
  compareRightFilename: string | null
  onSelectCompareRight: (filename: string) => void
  busyAction: string | null
  actionMessage: string | null
  errorMessage: string | null
  onAnalyze: (filename: string) => Promise<void>
  onTranscode: (filename: string) => Promise<void>
  onAssign: (filename: string) => Promise<void>
  onDelete: (filename: string) => Promise<void>
  replacePair: { sourceFilename: string; targetFilename: string } | null
  upgradeTargetFilename: string | null
  importSourceFilename: string | null
  needsMp3Conversion: boolean
  onOpenUpgradeCase: () => void
  onReplaceExistingSong: () => Promise<void>
  onImportSingleDownload: () => Promise<void>
  onSkipToNext: () => void
}): React.JSX.Element {
  const compareLeft = recording.files.find((file) => file.filename === compareLeftFilename) ?? null
  const compareRight = recording.files.find((file) => file.filename === compareRightFilename) ?? null
  const [pendingAssign, setPendingAssign] = useState<CollectionItem | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false)
  const confirmAssign = async (): Promise<void> => {
    if (!pendingAssign) return
    await onAssign(pendingAssign.filename)
    setPendingAssign(null)
  }
  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    await onDelete(pendingDelete)
    setPendingDelete(null)
  }

  return (
    <div className="space-y-4">
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      {actionMessage ? <Notice tone="success">{actionMessage}</Notice> : null}

      <ViewSection
        title={recordTitle(recording)}
        aside={<div className="text-[11px] text-zinc-500">{recording.files.length} files · {similarItems.length} local matches</div>}
      >
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          {queuePosition && queueTotal ? <span>{queuePosition} / {queueTotal}</span> : null}
          <span>Year {recording.canonical.year ?? '—'}</span>
          <span>Length {formatCompactDuration(recording.durationSeconds)}</span>
          <span>Claims {recording.claimCount}</span>
        </div>
      </ViewSection>

      <ViewSection title="Files On Record" borderless className="p-0" bodyClassName="mt-0">
        <ImportRecordFilesTable
          files={recording.files}
          referenceDurationSeconds={recording.durationSeconds}
          compareLeftFilename={compareLeftFilename}
          compareRightFilename={compareRightFilename}
          busyAction={busyAction}
          onSelectCompareLeft={onSelectCompareLeft}
          onSelectCompareRight={onSelectCompareRight}
          onAnalyze={(filename) => {
            void onAnalyze(filename)
          }}
          onTranscode={(filename) => {
            void onTranscode(filename)
          }}
          onDelete={setPendingDelete}
        />
      </ViewSection>

      <ViewSection title="Most Similar Local Matches" borderless className="p-0" bodyClassName="mt-0">
        <ImportRecordMatchesTable
          items={similarItems}
          currentRecordingId={recording.id}
          busyAction={busyAction}
          onAnalyze={(item) => {
            void onAnalyze(item.filename)
          }}
          onAssign={(item) => {
            if (isRiskyAssign(item, recording)) setPendingAssign(item)
            else void onAssign(item.filename)
          }}
        />
      </ViewSection>

      <ViewSection title="Crossfader" padding="sm">
        <ImportRecordCompare
          leftFilename={compareLeft?.filename ?? null}
          rightFilename={compareRight?.filename ?? null}
          leftDuration={null}
          rightDuration={null}
          enabled={Boolean(compareLeft && compareRight && compareLeft.filename !== compareRight.filename)}
        />
      </ViewSection>

      <ImportRecordDiscogsReleases recording={recording} />

      <ImportRecordActions
        busyAction={busyAction}
        recordingId={recording.id}
        upgradeTargetFilename={upgradeTargetFilename}
        importSourceFilename={importSourceFilename}
        needsMp3Conversion={needsMp3Conversion}
        replacePair={replacePair}
        onSkipToNext={onSkipToNext}
        onOpenUpgradeCase={onOpenUpgradeCase}
        onImportSingleDownload={() => {
          void onImportSingleDownload()
        }}
        onOpenReplace={() => setConfirmReplaceOpen(true)}
      />

      <ImportRecordDialogs
        recording={recording}
        pendingAssign={pendingAssign}
        pendingDelete={pendingDelete}
        confirmReplaceOpen={confirmReplaceOpen}
        replacePair={replacePair}
        busyAction={busyAction}
        onCloseAssign={() => setPendingAssign(null)}
        onConfirmAssign={() => {
          void confirmAssign()
        }}
        onCloseDelete={() => setPendingDelete(null)}
        onConfirmDelete={() => {
          void confirmDelete()
        }}
        onCloseReplace={() => setConfirmReplaceOpen(false)}
        onConfirmReplace={() => {
          void onReplaceExistingSong().then(() => setConfirmReplaceOpen(false))
        }}
      />
    </div>
  )
}

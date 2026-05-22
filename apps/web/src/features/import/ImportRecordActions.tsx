import { ActionButton } from '../../components/view/ActionButton'

export function ImportRecordActions({
  busyAction,
  recordingId,
  upgradeTargetFilename,
  importSourceFilename,
  needsMp3Conversion,
  replacePair,
  onSkipToNext,
  onOpenUpgradeCase,
  onImportSingleDownload,
  onOpenReplace
}: {
  busyAction: string | null
  recordingId: number
  upgradeTargetFilename: string | null
  importSourceFilename: string | null
  needsMp3Conversion: boolean
  replacePair: { sourceFilename: string; targetFilename: string } | null
  onSkipToNext: () => void
  onOpenUpgradeCase: () => void
  onImportSingleDownload: () => void
  onOpenReplace: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <ActionButton size="sm" onClick={onSkipToNext}>
        Skip And Go To Next
      </ActionButton>
      {upgradeTargetFilename ? (
        <ActionButton size="sm" tone="primary" disabled={busyAction === `upgrade-${upgradeTargetFilename}`} onClick={onOpenUpgradeCase}>
          {busyAction === `upgrade-${upgradeTargetFilename}` ? 'Opening…' : 'Download Better Version'}
        </ActionButton>
      ) : null}
      {importSourceFilename ? (
        <ActionButton size="sm" tone="primary" disabled={busyAction === `import-${importSourceFilename}`} onClick={onImportSingleDownload}>
          {busyAction === `import-${importSourceFilename}` ? 'Importing…' : 'Import'}
        </ActionButton>
      ) : null}
      {replacePair ? (
        <ActionButton size="sm" tone="primary" disabled={busyAction === `replace-${recordingId}`} onClick={onOpenReplace}>
          {busyAction === `replace-${recordingId}` ? 'Replacing…' : 'Import Replace Existing'}
        </ActionButton>
      ) : null}
      {needsMp3Conversion ? <span className="text-xs text-zinc-300">Convert download to 320 MP3 first.</span> : null}
    </div>
  )
}

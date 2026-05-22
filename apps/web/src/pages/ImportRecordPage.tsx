import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Notice } from '../components/view/Notice'
import { ImportRecordView } from '../features/import/ImportRecordView'
import { useImportRecordPageData } from '../features/import/useImportRecordPageData'
import { buildImportHref, buildImportRecordHref } from '../lib/urls'

export default function ImportRecordPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { recordingId } = useParams<{ recordingId: string }>()
  const [searchParams] = useSearchParams()
  const id = Number(recordingId)
  const query = searchParams.get('query') ?? ''
  const {
    recording,
    similarItems,
    replacePair,
    upgradeTargetFilename,
    importSourceFilename,
    needsMp3Conversion,
    queuePosition,
    queueTotal,
    nextRecordingId,
    compareLeftFilename,
    setCompareLeftFilename,
    compareRightFilename,
    setCompareRightFilename,
    busyAction,
    actionMessage,
    isPending,
    errorMessage,
    analyzeFile,
    transcodeToMp3320,
    assignToRecord,
    deleteFile,
    replaceExistingSong,
    openUpgradeCase,
    importSingleDownload
  } = useImportRecordPageData(id, query)

  if (isPending) return <Notice>Loading…</Notice>
  if (!recording) return <Notice tone={errorMessage ? 'error' : 'warning'}>{errorMessage ?? 'Record not found.'}</Notice>

  return (
    <ImportRecordView
      recording={recording}
      similarItems={similarItems}
      queuePosition={queuePosition}
      queueTotal={queueTotal}
      compareLeftFilename={compareLeftFilename}
      onSelectCompareLeft={setCompareLeftFilename}
      compareRightFilename={compareRightFilename}
      onSelectCompareRight={setCompareRightFilename}
      busyAction={busyAction}
      actionMessage={actionMessage}
      errorMessage={errorMessage}
      onAnalyze={analyzeFile}
      onTranscode={transcodeToMp3320}
      onAssign={assignToRecord}
      onDelete={deleteFile}
      replacePair={replacePair}
      upgradeTargetFilename={upgradeTargetFilename}
      importSourceFilename={importSourceFilename}
      needsMp3Conversion={needsMp3Conversion}
      onOpenUpgradeCase={() => {
        void openUpgradeCase()
      }}
      onReplaceExistingSong={replaceExistingSong}
      onImportSingleDownload={importSingleDownload}
      onSkipToNext={() => navigate(nextRecordingId != null ? buildImportRecordHref(nextRecordingId, query) : buildImportHref(query))}
    />
  )
}

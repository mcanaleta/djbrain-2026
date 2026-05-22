import { useEffect, useMemo, useState } from 'react'
import type { CollectionItem, RecordingDetails } from '@djbrain/shared/api'
import { buildImportRows, groupImportRows } from './importRows'

export function useImportRecordSelection(
  recording: RecordingDetails | null,
  recordingId: number,
  downloadItems: CollectionItem[] | undefined
) {
  const [compareLeftFilename, setCompareLeftFilename] = useState<string | null>(null)
  const [compareRightFilename, setCompareRightFilename] = useState<string | null>(null)

  useEffect(() => {
    const files = recording?.files ?? []
    setCompareLeftFilename((current) => (current && files.some((file) => file.filename === current) ? current : files[0]?.filename ?? null))
    setCompareRightFilename((current) =>
      current && files.some((file) => file.filename === current) && current !== files[0]?.filename ? current : files[1]?.filename ?? null
    )
  }, [recording?.files])

  const importRows = useMemo(
    () => groupImportRows(buildImportRows(downloadItems ?? [])).filter((row) => row.recordingId != null),
    [downloadItems]
  )
  const currentIndex = importRows.findIndex((row) => row.recordingId === recordingId)

  return {
    compareLeftFilename,
    setCompareLeftFilename,
    compareRightFilename,
    setCompareRightFilename,
    queuePosition: currentIndex >= 0 ? currentIndex + 1 : null,
    queueTotal: importRows.length || null,
    nextRecordingId: currentIndex >= 0 ? importRows[currentIndex + 1]?.recordingId ?? null : null
  }
}

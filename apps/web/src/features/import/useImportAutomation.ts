import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { getErrorMessage } from '../../lib/error-utils'
import type { ImportRow } from './importRows'

function getQueuedFilenames(
  rows: ImportRow[],
  key: 'identify' | 'import',
  match: (row: ImportRow) => boolean,
  queued: Set<string>
): string[] {
  return rows
    .filter((row) => match(row) && !queued.has(`${key}:${row.filename}`))
    .map((row) => row.filename)
}

export function useImportAutomation(
  rows: ImportRow[],
  enabled: boolean
): { queueMessage: string | null; queueError: string | null } {
  const queuedRef = useRef<Set<string>>(new Set())
  const [queueMessage, setQueueMessage] = useState<string | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const identifyFilenames = getQueuedFilenames(
      rows,
      'identify',
      (row) =>
        row.identificationStatus == null ||
        row.identificationStatus === 'pending' ||
        row.identificationStatus === 'error',
      queuedRef.current
    )
    if (identifyFilenames.length > 0) {
      setQueueError(null)
      identifyFilenames.forEach((filename) => queuedRef.current.add(`identify:${filename}`))
      api.collection.queueIdentificationProcessing(identifyFilenames).catch((error) => {
        identifyFilenames.forEach((filename) => queuedRef.current.delete(`identify:${filename}`))
        setQueueError(getErrorMessage(error, 'Failed to queue identification prep'))
      })
    }

    const importFilenames = getQueuedFilenames(
      rows,
      'import',
      (row) => row.prep === 'pending',
      queuedRef.current
    )
    if (importFilenames.length === 0) return
    setQueueError(null)
    importFilenames.forEach((filename) => queuedRef.current.add(`import:${filename}`))
    api.collection.queueImportProcessing(importFilenames)
      .then((result) => {
        if (result.queued > 0) {
          setQueueMessage(`Preparing ${result.queued} file${result.queued === 1 ? '' : 's'} for grouped track review.`)
        }
      })
      .catch((error) => {
        importFilenames.forEach((filename) => queuedRef.current.delete(`import:${filename}`))
        setQueueError(getErrorMessage(error, 'Failed to queue import prep'))
      })
  }, [enabled, rows])

  return { queueMessage, queueError }
}

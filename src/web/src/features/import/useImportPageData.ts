import { TrashIcon } from '@radix-ui/react-icons'
import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { HeaderAction } from '../../context/HeaderActionsContext'
import {
  COLLECTION_DOWNLOADS_QUERY_KEY,
  useCollectionStatusQuery
} from '../../hooks/useCollectionStatusQuery'
import { useSettingsQuery } from '../../hooks/useSettingsQuery'
import { getErrorMessage } from '../../lib/error-utils'
import { buildImportRows, groupImportRows } from './importRows'
import { useImportAutomation } from './useImportAutomation'

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected import list error')
}

export function useImportPageData(submittedQuery: string): {
  total: number
  groupedRows: ReturnType<typeof groupImportRows>
  isLoading: boolean
  musicFolderPath: string
  clearFoldersResult: string | null
  queueMessage: string | null
  errorMessage: string | null
  statusLastError: string | null
  refetch: () => Promise<unknown>
  headerActions: HeaderAction[]
} {
  const [actionError, setActionError] = useState<string | null>(null)
  const [isClearingFolders, setIsClearingFolders] = useState(false)
  const [clearFoldersResult, setClearFoldersResult] = useState<string | null>(null)

  const { data: settings, error: settingsError } = useSettingsQuery()
  const { data: status, error: statusError } = useCollectionStatusQuery(COLLECTION_DOWNLOADS_QUERY_KEY)
  const {
    data: listResult,
    error: listError,
    isPending: isLoading,
    refetch
  } = useQuery({
    queryKey: [...COLLECTION_DOWNLOADS_QUERY_KEY, submittedQuery],
    queryFn: () => api.collection.listDownloads(submittedQuery)
  })

  const rows = useMemo(() => buildImportRows(listResult?.items ?? []), [listResult?.items])
  const groupedRows = useMemo(() => groupImportRows(rows), [rows])
  const { queueMessage, queueError } = useImportAutomation(rows, status.automationEnabled === true)

  const clearEmptyFolders = useCallback(async (): Promise<void> => {
    setIsClearingFolders(true)
    setActionError(null)
    setClearFoldersResult(null)
    try {
      const count = await api.collection.clearEmptyFolders()
      setClearFoldersResult(count === 0 ? 'No empty folders found.' : `Removed ${count} empty folder${count === 1 ? '' : 's'}.`)
    } catch (error) {
      setActionError(formatError(error))
    } finally {
      setIsClearingFolders(false)
    }
  }, [])

  const headerActions = useMemo<HeaderAction[]>(
    () => [
      {
        key: 'clear-empty-folders',
        label: isClearingFolders ? 'Clearing empty folders…' : 'Clear empty folders',
        onSelect: () => { void clearEmptyFolders() },
        disabled: isClearingFolders,
        icon: TrashIcon
      }
    ],
    [clearEmptyFolders, isClearingFolders]
  )

  return {
    total: listResult?.total ?? 0,
    groupedRows,
    isLoading,
    musicFolderPath: settings?.musicFolderPath ?? '',
    clearFoldersResult,
    queueMessage,
    errorMessage:
      actionError ??
      queueError ??
      (listError
        ? formatError(listError)
        : statusError
          ? formatError(statusError)
          : settingsError
            ? formatError(settingsError)
            : null),
    statusLastError: status.lastError,
    refetch: () => refetch(),
    headerActions
  }
}

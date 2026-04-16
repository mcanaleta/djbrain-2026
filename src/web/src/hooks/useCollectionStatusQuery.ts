import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { CollectionSyncStatus } from '../../../shared/api'
import { api } from '../api/client'

export const COLLECTION_STATUS_QUERY_KEY = ['collection', 'status'] as const
export const COLLECTION_LIST_QUERY_KEY = ['collection', 'list'] as const
export const COLLECTION_DOWNLOADS_QUERY_KEY = ['collection', 'downloads'] as const

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null,
  automationEnabled: false,
  importPendingCount: 0,
  importProcessingCount: 0,
  importErrorCount: 0,
  queueBackend: 'memory',
  queueDepth: 0,
  audioHashVersion: 1,
  audioAnalysisVersion: 1,
  importReviewVersion: 1
}

export function useCollectionStatusQuery(invalidateQueryKey?: QueryKey) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: COLLECTION_STATUS_QUERY_KEY,
    queryFn: api.collection.getStatus
  })

  useEffect(() => {
    const unsubscribe = api.collection.onUpdated((nextStatus) => {
      queryClient.setQueryData(COLLECTION_STATUS_QUERY_KEY, nextStatus)
      if (invalidateQueryKey) void queryClient.invalidateQueries({ queryKey: invalidateQueryKey })
    })
    return unsubscribe
  }, [invalidateQueryKey, queryClient])

  return {
    ...query,
    data: query.data ?? EMPTY_STATUS
  }
}

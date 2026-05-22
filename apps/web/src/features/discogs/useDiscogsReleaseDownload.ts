import { useCallback, useState } from 'react'
import type { DiscogsReleaseDownloadResult } from '@djbrain/shared/api'
import { api } from '../../api/client'
import { useAsyncAction } from '../../hooks/useAsyncAction'

export function useDiscogsReleaseDownload(releaseId: number | null) {
  const actions = useAsyncAction()
  const [result, setResult] = useState<DiscogsReleaseDownloadResult | null>(null)

  const run = useCallback(async () => {
    if (!releaseId) return
    await actions.run({
      key: 'download-release',
      successMessage: 'Release download completed.',
      errorFallback: 'Failed to download release tracks.',
      action: async () => {
        setResult(await api.collection.downloadDiscogsRelease(releaseId))
      }
    })
  }, [actions, releaseId])

  return {
    result,
    isRunning: actions.busyAction === 'download-release',
    errorMessage: actions.errorMessage,
    actionMessage: actions.actionMessage,
    run
  }
}

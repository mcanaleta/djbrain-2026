import { useCallback, useRef, useState } from 'react'
import { getErrorMessage } from '../lib/error-utils'

type AsyncActionState = {
  busyAction: string | null
  errorMessage: string | null
  actionMessage: string | null
}

type RunOptions = {
  key: string
  action: () => Promise<void>
  successMessage?: string
  errorFallback?: string
}

export function useAsyncAction(): AsyncActionState & {
  run: (options: RunOptions) => Promise<void>
  clearMessages: () => void
} {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const run = useCallback(async ({ key, action, successMessage, errorFallback }: RunOptions): Promise<void> => {
    setBusyAction(key)
    setErrorMessage(null)
    setActionMessage(null)
    try {
      await action()
      if (mountedRef.current && successMessage) setActionMessage(successMessage)
    } catch (error) {
      if (mountedRef.current) setErrorMessage(getErrorMessage(error, errorFallback))
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }, [])

  const clearMessages = useCallback(() => {
    setErrorMessage(null)
    setActionMessage(null)
  }, [])

  return { busyAction, errorMessage, actionMessage, run, clearMessages }
}

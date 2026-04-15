import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DotsHorizontalIcon, InfoCircledIcon, ReloadIcon } from '@radix-ui/react-icons'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { CollectionSyncStatus } from '../../../shared/api'
import { api } from '../api/client'
import { resolveNavTitle } from '../app/nav'

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected collection action error'
}

const menuItemClassName =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-sm text-zinc-200 outline-none focus:bg-zinc-900 data-[disabled]:opacity-50'

export default function TopBar(): React.JSX.Element {
  const location = useLocation()
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  const title = resolveNavTitle(location.pathname)

  useEffect(() => {
    let active = true

    const loadStatus = async (): Promise<void> => {
      try {
        const status = (await api.collection.getStatus()) as CollectionSyncStatus
        if (!active) {
          return
        }
        setIsSyncing(status.isSyncing)
        setSyncError(status.lastError)
      } catch (error) {
        if (!active) {
          return
        }
        setSyncError(formatError(error))
      }
    }

    void loadStatus()
    const unsubscribe = api.collection.onUpdated((status) => {
      if (!active) {
        return
      }
      setIsSyncing(status.isSyncing)
      setSyncError(status.lastError)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const handleSyncNow = async (): Promise<void> => {
    try {
      const status = await api.collection.syncNow()
      setIsSyncing(status.isSyncing)
      setSyncError(status.lastError)
    } catch (error) {
      setSyncError(formatError(error))
    }
  }

  return (
    <header className="flex h-12 items-center gap-3 border-b border-zinc-800 bg-zinc-950/60 px-4">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold text-zinc-100">{title}</h1>
      </div>
      <div className="flex-1" />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
            aria-label="Actions"
          >
            <DotsHorizontalIcon />
            Actions
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={8}
            className="min-w-52 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-lg"
          >
            <DropdownMenu.Item
              className={menuItemClassName}
              disabled={isSyncing}
              onSelect={() => {
                void handleSyncNow()
              }}
            >
              <ReloadIcon />
              {isSyncing ? 'Syncing collection…' : 'Sync Collection'}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-zinc-800" />
            <DropdownMenu.Item className={menuItemClassName} onSelect={() => {}}>
              <InfoCircledIcon />
              About (stub)
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {syncError ? <div className="max-w-72 truncate text-xs text-red-300">{syncError}</div> : null}
    </header>
  )
}

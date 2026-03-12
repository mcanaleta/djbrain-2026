import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DotsHorizontalIcon, GearIcon, InfoCircledIcon, ReloadIcon } from '@radix-ui/react-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { resolveNavTitle } from '../app/nav'
import type { SearchScope } from '../layout/AppShell'

type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

type TopBarProps = {
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  onSearchSubmit: (scope: SearchScope) => void
}

type SearchAction = {
  scope: SearchScope
  label: string
  hint: string
}

const SEARCH_ACTIONS: SearchAction[] = [
  { scope: 'collection', label: 'Search collection', hint: 'Default' },
  { scope: 'discogs', label: 'Search Discogs', hint: 'Online provider' },
  { scope: 'online', label: 'Search online', hint: 'All indexed sources' }
]

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected collection action error'
}

const menuItemClassName =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-sm text-zinc-200 outline-none focus:bg-zinc-900 data-[disabled]:opacity-50'

export default function TopBar({
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit
}: TopBarProps): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [isSearchMenuOpen, setIsSearchMenuOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const searchContainerRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const title = resolveNavTitle(location.pathname)
  const trimmedQuery = searchQuery.trim()
  const shouldShowSearchMenu = isSearchMenuOpen && trimmedQuery.length > 0
  const searchActions = useMemo(() => SEARCH_ACTIONS, [])

  useEffect(() => {
    let active = true

    const loadStatus = async (): Promise<void> => {
      try {
        const status = (await window.api.collection.getStatus()) as CollectionSyncStatus
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
    const unsubscribe = window.api.collection.onUpdated((status) => {
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
      const status = await window.api.collection.syncNow()
      setIsSyncing(status.isSyncing)
      setSyncError(status.lastError)
    } catch (error) {
      setSyncError(formatError(error))
    }
  }

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (!searchContainerRef.current?.contains(event.target as Node)) {
        setIsSearchMenuOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        setIsSearchMenuOpen(searchInputRef.current?.value.trim().length ? true : false)
        setHighlightedIndex(0)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const submitSearch = (scope: SearchScope): void => {
    onSearchSubmit(scope)
    setIsSearchMenuOpen(false)
    setHighlightedIndex(0)
  }

  const handleSearchInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!trimmedQuery) {
        return
      }
      setIsSearchMenuOpen(true)
      setHighlightedIndex((currentIndex) => (currentIndex + 1) % searchActions.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!trimmedQuery) {
        return
      }
      setIsSearchMenuOpen(true)
      setHighlightedIndex((currentIndex) =>
        currentIndex === 0 ? searchActions.length - 1 : currentIndex - 1
      )
      return
    }

    if (event.key === 'Enter') {
      if (!trimmedQuery) {
        return
      }
      event.preventDefault()
      submitSearch(searchActions[highlightedIndex]?.scope ?? 'collection')
      return
    }

    if (event.key === 'Escape') {
      setIsSearchMenuOpen(false)
    }
  }

  return (
    <header className="flex h-12 items-center gap-3 border-b border-zinc-800 bg-zinc-950/60 px-4">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold text-zinc-100">{title}</h1>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div ref={searchContainerRef} className="relative w-full max-w-2xl">
          <div className="flex w-full items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/40 focus-within:ring-2 focus-within:ring-zinc-700">
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                onSearchQueryChange(event.target.value)
                setIsSearchMenuOpen(event.target.value.trim().length > 0)
                setHighlightedIndex(0)
              }}
              onFocus={() => {
                setIsSearchMenuOpen(trimmedQuery.length > 0)
              }}
              onKeyDown={handleSearchInputKeyDown}
              placeholder="Search collection…"
              className="h-8 w-full bg-transparent px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
          </div>

          {shouldShowSearchMenu ? (
            <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl">
              {searchActions.map((action, index) => {
                const isHighlighted = index === highlightedIndex
                return (
                  <button
                    key={action.scope}
                    type="button"
                    onMouseEnter={() => {
                      setHighlightedIndex(index)
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      submitSearch(action.scope)
                    }}
                    className={[
                      'flex w-full items-center justify-between px-3 py-3 text-left text-sm',
                      isHighlighted
                        ? 'bg-zinc-900 text-zinc-100'
                        : 'text-zinc-300 hover:bg-zinc-900/70'
                    ].join(' ')}
                  >
                    <span>{action.label}</span>
                    <span className="truncate pl-4 text-xs text-zinc-500">
                      {trimmedQuery} · {action.hint}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>

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
            <DropdownMenu.Item className={menuItemClassName} onSelect={() => navigate('/settings')}>
              <GearIcon />
              Open Settings
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

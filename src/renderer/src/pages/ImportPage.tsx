import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type CollectionItem = {
  filename: string
  filesize: number
}

type CollectionListResult = {
  items: CollectionItem[]
  total: number
}

type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

type DerivedTrack = {
  artist: string
  title: string
  year: string
}

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected import list error'
}

function normalizeTrackPart(rawValue: string): string {
  return rawValue.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function deriveTrackFromFilename(filename: string): DerivedTrack {
  const basename = filename.split('/').pop() ?? filename
  const withoutExtension = basename.replace(/\.[^.]+$/, '')
  const yearMatch = withoutExtension.match(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/)
  const year = yearMatch?.[1] ?? '—'

  const withoutYear = yearMatch
    ? withoutExtension.replace(new RegExp(`[\\[\\(\\{]?${year}[\\]\\)\\}]?`, 'g'), ' ')
    : withoutExtension

  const normalized = normalizeTrackPart(withoutYear)
  const separatorIndex = normalized.indexOf(' - ')

  if (separatorIndex > 0) {
    const artist = normalizeTrackPart(normalized.slice(0, separatorIndex)) || 'Unknown'
    const title = normalizeTrackPart(normalized.slice(separatorIndex + 3)) || 'Unknown title'
    return {
      artist,
      title,
      year
    }
  }

  return {
    artist: 'Unknown',
    title: normalized || 'Unknown title',
    year
  }
}

function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

export default function ImportPage(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState({
    query: '',
    submittedAt: 0
  })
  const [items, setItems] = useState<CollectionItem[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)

  const latestQueryRef = useRef(submittedSearch.query)
  const requestIdRef = useRef(0)
  latestQueryRef.current = submittedSearch.query

  const loadItems = useCallback(async (searchQuery: string): Promise<void> => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoading(true)

    try {
      const result = (await window.api.collection.listDownloads(
        searchQuery
      )) as CollectionListResult
      if (requestIdRef.current !== requestId) {
        return
      }
      setItems(result.items)
      setTotal(result.total)
      setErrorMessage(null)
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return
      }
      setErrorMessage(formatError(error))
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    let active = true

    const loadStatus = async (): Promise<void> => {
      try {
        const nextStatus = await window.api.collection.getStatus()
        if (!active) {
          return
        }
        setStatus(nextStatus)
      } catch (error) {
        if (!active) {
          return
        }
        setErrorMessage(formatError(error))
      }
    }

    void loadStatus()

    const unsubscribe = window.api.collection.onUpdated((nextStatus) => {
      if (!active) {
        return
      }
      setStatus(nextStatus)
      void loadItems(latestQueryRef.current)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [loadItems])

  useEffect(() => {
    void loadItems(submittedSearch.query)
  }, [loadItems, submittedSearch.query, submittedSearch.submittedAt])

  const handleSearchSubmit = (): void => {
    setSubmittedSearch({
      query: query.trim(),
      submittedAt: Date.now()
    })
  }

  const handleSyncNow = async (): Promise<void> => {
    try {
      const nextStatus = await window.api.collection.syncNow()
      setStatus(nextStatus)
      await loadItems(latestQueryRef.current)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const rows = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        ...deriveTrackFromFilename(item.filename)
      })),
    [items]
  )

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Import</div>
            <div className="mt-1 text-sm text-zinc-400">
              Items from configured download folders (SQLite-backed).
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void handleSyncNow()
            }}
            disabled={status.isSyncing}
            className="inline-flex h-8 items-center rounded-md border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-100 hover:bg-zinc-950/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status.isSyncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') {
                return
              }
              event.preventDefault()
              handleSearchSubmit()
            }}
            placeholder="Search download items…"
            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950/30 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-700"
          />
          <div className="shrink-0 text-xs text-zinc-400">{total} items</div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="grid grid-cols-5 gap-4 border-b border-zinc-800 pb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
          <div>Title</div>
          <div>Artist</div>
          <div>Year</div>
          <div>Size</div>
          <div>Filename</div>
        </div>

        <div className="divide-y divide-zinc-800">
          {isLoading ? (
            <div className="py-4 text-sm text-zinc-400">Loading import items…</div>
          ) : rows.length === 0 ? (
            <div className="py-4 text-sm text-zinc-400">
              No items found in download folders. Configure paths in Settings and sync.
            </div>
          ) : (
            rows.map((row) => (
              <div key={row.filename} className="grid grid-cols-5 gap-4 py-3 text-sm text-zinc-200">
                <div className="truncate">{row.title}</div>
                <div className="truncate text-zinc-300">{row.artist}</div>
                <div className="text-zinc-300">{row.year}</div>
                <div className="text-zinc-300">{formatFileSize(row.filesize)}</div>
                <div className="truncate text-zinc-400" title={row.filename}>
                  {row.filename}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {(errorMessage || status.lastError) && (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-200">
          {errorMessage ?? status.lastError}
        </div>
      )}
    </div>
  )
}

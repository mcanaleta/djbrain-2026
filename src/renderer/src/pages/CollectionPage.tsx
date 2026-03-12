import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppShellOutletContext } from '../layout/AppShell'

type CollectionItem = {
  filename: string
  filesize: number
}

type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

type CollectionListResult = {
  items: CollectionItem[]
  total: number
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

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">{children}</div>
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected collection error'
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

  const fractionDigits = value >= 10 ? 1 : 2
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
}

export default function CollectionPage(): React.JSX.Element {
  const { submittedSearch } = useOutletContext<AppShellOutletContext>()
  const [items, setItems] = useState<CollectionItem[]>([])
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const requestIdRef = useRef(0)
  const activeQuery = submittedSearch.scope === 'collection' ? submittedSearch.query : ''
  const latestQueryRef = useRef(activeQuery)

  latestQueryRef.current = activeQuery

  const loadItems = useCallback(async (query: string): Promise<void> => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoading(true)

    try {
      const result = (await window.api.collection.list(query)) as CollectionListResult
      if (requestIdRef.current !== requestId) {
        return
      }

      setItems(result.items)
      setFilteredTotal(result.total)
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
    void loadItems(activeQuery)
  }, [activeQuery, loadItems, submittedSearch.submittedAt])

  const handleSyncNow = async (): Promise<void> => {
    try {
      const nextStatus = await window.api.collection.syncNow()
      setStatus(nextStatus)
      await loadItems(latestQueryRef.current)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const derivedRows = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        ...deriveTrackFromFilename(item.filename)
      })),
    [items]
  )

  const statusText = status.lastSyncedAt
    ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`
    : 'Not synced yet'

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Collection</div>
            <div className="text-xs text-zinc-400">Local tracks indexed in SQLite</div>
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
        <div className="mt-2 text-xs text-zinc-500">
          {statusText} · {status.itemCount} indexed · {filteredTotal} shown
        </div>
      </Card>

      <Card>
        <div className="grid grid-cols-5 gap-4 border-b border-zinc-800 pb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
          <div>Title</div>
          <div>Artist</div>
          <div>Year</div>
          <div>Size</div>
          <div>Filename</div>
        </div>

        <div className="divide-y divide-zinc-800">
          {isLoading ? (
            <div className="py-4 text-sm text-zinc-400">Loading collection…</div>
          ) : derivedRows.length === 0 ? (
            <div className="py-4 text-sm text-zinc-400">
              No tracks found. Use Sync Now after configuring folders.
            </div>
          ) : (
            derivedRows.map((row) => (
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

        <div className="mt-3 text-xs text-zinc-500">
          Search matches against filename text via SQLite FTS.
        </div>
      </Card>

      {(errorMessage || status.lastError) && (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-200">
          {errorMessage ?? status.lastError}
        </div>
      )}
    </div>
  )
}

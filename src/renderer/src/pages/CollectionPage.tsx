import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppShellOutletContext } from '../layout/AppShell'
import { ActionButton, DataTable, Notice, ViewSection, type DataTableColumn } from '../components/view'
import { getErrorMessage } from '../lib/error-utils'
import { deriveTrackSummaryFromFilename, formatFileSize } from '../lib/music-file'
import { usePlayer } from '../context/PlayerContext'

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

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null
}

type CollectionRow = CollectionItem & {
  artist: string
  title: string
  year: string
}

function makeColumns(onPlay: (row: CollectionRow) => void): DataTableColumn<CollectionRow>[] {
  return [
    {
      key: 'play',
      header: '',
      cellClassName: 'w-8',
      render: (row) => (
        <button
          title="Play"
          onClick={(e) => {
            e.stopPropagation()
            onPlay(row)
          }}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-600 text-xs text-zinc-300 hover:border-zinc-400 hover:text-white"
        >
          ▶
        </button>
      )
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[220px] truncate',
      render: (row) => row.title
    },
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[180px] truncate text-zinc-300',
      render: (row) => row.artist
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-300',
      render: (row) => row.year
    },
    {
      key: 'size',
      header: 'Size',
      cellClassName: 'text-zinc-300',
      render: (row) => formatFileSize(row.filesize)
    },
    {
      key: 'filename',
      header: 'Filename',
      cellClassName: 'max-w-[420px] truncate text-zinc-400',
      render: (row) => <span title={row.filename}>{row.filename}</span>
    }
  ]
}

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected collection error')
}

export default function CollectionPage(): React.JSX.Element {
  const { submittedSearch } = useOutletContext<AppShellOutletContext>()
  const player = usePlayer()

  const handlePlay = useCallback(
    (row: CollectionRow) => {
      player.play({
        url: `/api/media?filename=${encodeURIComponent(row.filename)}`,
        filename: row.filename,
        title: row.title,
        artist: row.artist !== 'Unknown artist' ? row.artist : ''
      })
    },
    [player]
  )

  const columns = useMemo(() => makeColumns(handlePlay), [handlePlay])
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
        ...deriveTrackSummaryFromFilename(item.filename)
      })),
    [items]
  )

  const statusText = status.lastSyncedAt
    ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`
    : 'Not synced yet'

  return (
    <div className="space-y-4">
      <ViewSection
        title="Collection"
        subtitle="Local tracks indexed in SQLite."
        aside={
          <ActionButton
            type="button"
            disabled={status.isSyncing}
            onClick={() => {
              void handleSyncNow()
            }}
          >
            {status.isSyncing ? 'Syncing…' : 'Sync Now'}
          </ActionButton>
        }
      >
        <div className="text-xs text-zinc-500">
          {statusText} · {status.itemCount} indexed · {filteredTotal} shown
        </div>
      </ViewSection>

      <ViewSection
        title="Tracks"
        subtitle="Search matches against filename text via SQLite FTS."
        className="p-0"
        bodyClassName="mt-0"
      >
        <DataTable
          columns={columns}
          rows={derivedRows}
          getRowKey={(row) => row.filename}
          loading={isLoading}
          loadingMessage="Loading collection…"
          emptyMessage="No tracks found. Use Sync Now after configuring folders."
          tableClassName="min-w-[820px]"
          className="rounded-none border-0"
        />
      </ViewSection>

      {errorMessage || status.lastError ? (
        <Notice tone="error" className="text-sm">
          {errorMessage ?? status.lastError}
        </Notice>
      ) : null}
    </div>
  )
}

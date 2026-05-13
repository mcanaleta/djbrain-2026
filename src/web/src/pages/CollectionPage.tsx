import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CollectionItem, CollectionListResult, CollectionSyncStatus, UpgradeCase } from '../../../shared/api'
import { api } from '../api/client'
import {
  ActionButton,
  DataTable,
  LabeledInput,
  Notice,
  Pill,
  ViewSection,
  type DataTableColumn
} from '../components/view'
import { getErrorMessage } from '../lib/error-utils'
import { deriveTrackSummaryFromFilename, formatFileSize } from '../lib/music-file'
import { usePlayer } from '../context/PlayerContext'

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null
}
const COLLECTION_VIEW_LIMIT = 100

type CollectionRow = CollectionItem & {
  artist: string
  title: string
  year: string
}

function makeColumns(
  onPlay: (row: CollectionRow) => void,
  onUpgrade: (row: CollectionRow) => void,
  upgradesByFilename: Map<string, UpgradeCase>
): DataTableColumn<CollectionRow>[] {
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
      cellClassName: 'max-w-[360px] truncate text-zinc-400',
      render: (row) => <span title={row.filename}>{row.filename}</span>
    },
    {
      key: 'upgrade',
      header: 'Upgrade',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => {
        const upgradeCase = upgradesByFilename.get(row.filename)
        const label =
          upgradeCase?.status === 'pending_reanalyze'
            ? 'Pending RB'
            : upgradeCase
              ? 'Open'
              : 'Upgrade'
        return (
          <div className="flex items-center gap-2">
            {upgradeCase?.status === 'pending_reanalyze' ? (
              <Pill tone="primary">Pending RB</Pill>
            ) : null}
            <ActionButton
              size="xs"
              tone={upgradeCase ? 'primary' : 'default'}
              onClick={(event) => {
                event.stopPropagation()
                onUpgrade(row)
              }}
            >
              {label}
            </ActionButton>
          </div>
        )
      }
    }
  ]
}

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected collection error')
}

export default function CollectionPage(): React.JSX.Element {
  const navigate = useNavigate()
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

  const [items, setItems] = useState<CollectionItem[]>([])
  const [upgradesByFilename, setUpgradesByFilename] = useState<Map<string, UpgradeCase>>(new Map())
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')

  const requestIdRef = useRef(0)
  const latestQueryRef = useRef(submittedQuery)

  latestQueryRef.current = submittedQuery

  const loadUpgradeCases = useCallback(async (): Promise<void> => {
    try {
      const cases = await api.upgrades.list()
      setUpgradesByFilename(
        new Map(
          cases
            .filter((item) => item.status !== 'completed')
            .map((item) => [item.collectionFilename, item])
        )
      )
    } catch {
      // Ignore upgrade list failures on the collection page.
    }
  }, [])

  const handleOpenUpgrade = useCallback(
    async (row: CollectionRow): Promise<void> => {
      try {
        const upgradeCase = await api.upgrades.open(row.filename)
        setUpgradesByFilename((current) => new Map(current).set(upgradeCase.collectionFilename, upgradeCase))
        navigate(`/upgrades/${upgradeCase.id}`)
      } catch (error) {
        setErrorMessage(formatError(error))
      }
    },
    [navigate]
  )

  const handleOpenItem = useCallback(
    (row: CollectionRow): void => {
      navigate(`/collection/item?filename=${encodeURIComponent(row.filename)}`)
    },
    [navigate]
  )

  const columns = useMemo(
    () => makeColumns(handlePlay, (row) => void handleOpenUpgrade(row), upgradesByFilename),
    [handleOpenUpgrade, handlePlay, upgradesByFilename]
  )

  const loadItems = useCallback(async (query: string): Promise<void> => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoading(true)

    try {
      const result = (await api.collection.list(query, COLLECTION_VIEW_LIMIT)) as CollectionListResult
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
        const nextStatus = await api.collection.getStatus()
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
    void loadUpgradeCases()
    const unsubscribe = api.collection.onUpdated((nextStatus) => {
      if (!active) {
        return
      }
      setStatus(nextStatus)
      void loadItems(latestQueryRef.current)
      void loadUpgradeCases()
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [loadItems, loadUpgradeCases])

  useEffect(() => {
    void loadItems(submittedQuery)
  }, [loadItems, submittedQuery])

  const handleSyncNow = async (): Promise<void> => {
    try {
      const nextStatus = await api.collection.syncNow()
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
          {statusText} · {status.itemCount} indexed · top {COLLECTION_VIEW_LIMIT} shown ({filteredTotal})
        </div>
      </ViewSection>

      <ViewSection
        title="Tracks"
        subtitle="Search matches against filename text via SQLite FTS."
        className="space-y-3 p-0"
        bodyClassName="mt-0"
      >
        <form
          className="flex flex-wrap items-end gap-2 border-b border-zinc-800 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            setSubmittedQuery(searchDraft.trim())
          }}
        >
          <LabeledInput
            label="Search"
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Artist, title, filename…"
            className="min-w-[220px] flex-1"
          />
          <ActionButton type="submit" size="xs" tone="primary">
            Search
          </ActionButton>
          <ActionButton
            size="xs"
            disabled={!submittedQuery && !searchDraft}
            onClick={() => {
              setSearchDraft('')
              setSubmittedQuery('')
            }}
          >
            Reset
          </ActionButton>
        </form>
        <DataTable
          columns={columns}
          rows={derivedRows}
          getRowKey={(row) => row.filename}
          onRowClick={handleOpenItem}
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

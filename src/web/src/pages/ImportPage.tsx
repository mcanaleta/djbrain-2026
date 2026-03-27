import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLinkIcon, OpenInNewWindowIcon, PauseIcon, PlayIcon, TrashIcon } from '@radix-ui/react-icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { ActionButton, DataTable, LabeledInput, Notice, ViewSection, type DataTableColumn } from '../components/view'
import { usePlayer, localFileUrl } from '../context/PlayerContext'
import type { CollectionItem, CollectionSyncStatus } from '../../../shared/api'
import {
  deriveTrackSummaryFromFilename,
  formatCompactDuration,
  formatFileSize
} from '../lib/music-file'

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null,
  importPendingCount: 0,
  importProcessingCount: 0,
  importErrorCount: 0,
  queueBackend: 'memory',
  queueDepth: 0,
  audioHashVersion: 1,
  audioAnalysisVersion: 1,
  importReviewVersion: 1
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Unexpected import list error'
}

type ImportRow = CollectionItem & {
  artist: string
  title: string
  year: string
  prep: string
}

export default function ImportPage(): React.JSX.Element {
  const player = usePlayer()
  const navigate = useNavigate()
  const [musicFolderPath, setMusicFolderPath] = useState<string>('')
  const [downloadFolderPaths, setDownloadFolderPaths] = useState<string[]>([])

  const [query, setQuery] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState({ query: '', submittedAt: 0 })
  const [items, setItems] = useState<CollectionItem[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)
  const [isClearingFolders, setIsClearingFolders] = useState(false)
  const [clearFoldersResult, setClearFoldersResult] = useState<string | null>(null)
  const [queueMessage, setQueueMessage] = useState<string | null>(null)
  const [queueLoading, setQueueLoading] = useState<'process' | 'refresh' | null>(null)

  const latestQueryRef = useRef(submittedSearch.query)
  const requestIdRef = useRef(0)
  latestQueryRef.current = submittedSearch.query

  useEffect(() => {
    api.settings.get().then((settings) => {
      setMusicFolderPath(settings.musicFolderPath)
      setDownloadFolderPaths(settings.downloadFolderPaths)
    }).catch(() => {})
  }, [])

  const loadItems = useCallback(async (searchQuery: string, silent: boolean = false): Promise<void> => {
    const requestId = ++requestIdRef.current
    if (!silent) setIsLoading(true)
    try {
      const result = await api.collection.listDownloads(searchQuery)
      if (requestIdRef.current !== requestId) return
      setItems(result.items)
      setTotal(result.total)
      setErrorMessage(null)
    } catch (error) {
      if (requestIdRef.current !== requestId) return
      setErrorMessage(formatError(error))
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    api.collection.getStatus().then((s) => { if (active) setStatus(s) }).catch(() => {})
    const unsub = api.collection.onUpdated((s) => {
      if (!active) return
      setStatus(s)
      void loadItems(latestQueryRef.current, true)
    })
    return () => { active = false; unsub() }
  }, [loadItems])

  useEffect(() => {
    void loadItems(submittedSearch.query)
  }, [loadItems, submittedSearch.query, submittedSearch.submittedAt])

  const handleSyncNow = async (): Promise<void> => {
    try {
      setStatus(await api.collection.syncNow())
      await loadItems(latestQueryRef.current)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const handlePlay = (item: ImportRow): void => {
    if (!musicFolderPath) return
    player.play({
      url: localFileUrl(musicFolderPath, item.filename),
      filename: item.filename,
      title: item.title,
      artist: item.artist
    })
  }

  const handleDeleteFile = async (filename: string): Promise<void> => {
    try {
      await api.collection.deleteFile(filename)
      // Optimistically remove from local list; sync will confirm
      setItems((prev) => prev.filter((i) => i.filename !== filename))
      setTotal((prev) => prev - 1)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const handleShowInFinder = (filename: string): void => {
    void api.collection.showInFinder(filename)
  }

  const handleOpenInPlayer = (filename: string): void => {
    void api.collection.openInPlayer(filename)
  }

  const handleClearEmptyFolders = async (): Promise<void> => {
    setIsClearingFolders(true)
    setClearFoldersResult(null)
    try {
      const count = await api.collection.clearEmptyFolders()
      setClearFoldersResult(count === 0 ? 'No empty folders found.' : `Removed ${count} empty folder${count === 1 ? '' : 's'}.`)
    } catch (error) {
      setClearFoldersResult(`Error: ${formatError(error)}`)
    } finally {
      setIsClearingFolders(false)
    }
  }

  const rows = useMemo(
    () =>
      items.map((item) => {
        const fallback = deriveTrackSummaryFromFilename(item.filename)
        return {
          ...item,
          artist: item.importArtist || fallback.artist,
          title: item.importTitle ? `${item.importTitle}${item.importVersion ? ` (${item.importVersion})` : ''}` : fallback.title,
          year: item.importYear || fallback.year,
          prep: item.importStatus ?? 'pending'
        }
      }),
    [items]
  )

  const stop = (event: React.SyntheticEvent): void => {
    event.stopPropagation()
  }

  const handleQueueProcessing = async (force: boolean): Promise<void> => {
    if (rows.length === 0) return
    setQueueLoading(force ? 'refresh' : 'process')
    try {
      const result = await api.collection.queueImportProcessing(rows.map((row) => row.filename), force)
      setQueueMessage(
        result.queued === 0
          ? force
            ? 'Nothing queued for refresh.'
            : 'Nothing pending to process.'
          : `${force ? 'Refreshing' : 'Processing'} ${result.queued} file${result.queued === 1 ? '' : 's'} in background.`
      )
      await loadItems(latestQueryRef.current)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setQueueLoading(null)
    }
  }

  const columns: DataTableColumn<ImportRow>[] = [
    {
      key: 'play',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => {
        const isCurrentTrack = player.track?.filename === row.filename
        return (
          <button
            type="button"
            onClick={(event) => {
              stop(event)
              handlePlay(row)
            }}
            disabled={!musicFolderPath}
            title={isCurrentTrack && player.isPlaying ? 'Pause' : 'Play'}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:opacity-30 ${
              isCurrentTrack
                ? 'border-zinc-500 bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
            }`}
          >
            {isCurrentTrack && player.isPlaying ? (
              <PauseIcon className="h-3 w-3" />
            ) : (
              <PlayIcon className="h-3 w-3" />
            )}
          </button>
        )
      }
    },
    {
      key: 'path',
      header: 'Path',
      cellClassName: 'max-w-[420px] truncate text-zinc-100',
      render: (row) => <span title={row.filename}>{row.filename}</span>
    },
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[180px] truncate text-zinc-300',
      render: (row) => <span title={row.artist}>{row.artist}</span>
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[240px] truncate text-zinc-300',
      render: (row) => <span title={row.title}>{row.title}</span>
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-400',
      render: (row) => row.year
    },
    {
      key: 'prep',
      header: 'Prep',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) =>
        row.prep === 'ready'
          ? 'ready'
          : row.prep === 'processing'
            ? '…'
            : row.prep === 'error'
              ? 'error'
              : 'pending'
    },
    {
      key: 'size',
      header: 'Size',
      cellClassName: 'text-zinc-400',
      render: (row) => formatFileSize(row.filesize)
    },
    {
      key: 'duration',
      header: 'Dur.',
      cellClassName: 'tabular-nums text-zinc-400',
      render: (row) => formatCompactDuration(row.duration)
    },
    {
      key: 'finder',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            stop(event)
            handleShowInFinder(row.filename)
          }}
          title="Show in Finder"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          <OpenInNewWindowIcon className="h-3.5 w-3.5" />
        </button>
      )
    },
    {
      key: 'player',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            stop(event)
            handleOpenInPlayer(row.filename)
          }}
          title="Open in system player"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          <ExternalLinkIcon className="h-3.5 w-3.5" />
        </button>
      )
    },
    {
      key: 'delete',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            stop(event)
            void handleDeleteFile(row.filename)
          }}
          title="Delete file"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-rose-950/40 hover:text-rose-300"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      )
    }
  ]

  return (
    <div className="space-y-4">
      <ViewSection
        title="Downloads"
        subtitle="Files in download folders ready to preview and import."
        aside={
          <div className="flex items-center gap-2">
            <ActionButton
              type="button"
              disabled={isClearingFolders}
              onClick={() => {
                void handleClearEmptyFolders()
              }}
            >
              {isClearingFolders ? 'Clearing…' : 'Clear empty folders'}
            </ActionButton>
            <ActionButton
              type="button"
              disabled={status.isSyncing}
              onClick={() => {
                void handleSyncNow()
              }}
            >
              {status.isSyncing ? 'Syncing…' : 'Sync Now'}
            </ActionButton>
          </div>
        }
      >
        {clearFoldersResult ? <div className="mb-3 text-xs text-zinc-400">{clearFoldersResult}</div> : null}
        <div className="flex items-end gap-3">
          <LabeledInput
            label="Search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              setSubmittedSearch({ query: query.trim(), submittedAt: Date.now() })
            }}
            placeholder="Search download items…"
            className="flex-1"
            inputClassName="h-9 rounded-md border-zinc-800 bg-zinc-950/30"
          />
          <div className="shrink-0 pb-1 text-xs text-zinc-400">{total} items</div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionButton size="xs" tone={submittedSearch.query ? 'default' : 'primary'} onClick={() => {
            setQuery('')
            setSubmittedSearch({ query: '', submittedAt: Date.now() })
          }}>
            All
          </ActionButton>
          <ActionButton size="xs" disabled={rows.length === 0 || queueLoading !== null} onClick={() => { void handleQueueProcessing(false) }}>
            {queueLoading === 'process' ? 'Processing…' : 'Process Visible'}
          </ActionButton>
          <ActionButton size="xs" disabled={rows.length === 0 || queueLoading !== null} onClick={() => { void handleQueueProcessing(true) }}>
            {queueLoading === 'refresh' ? 'Refreshing…' : 'Refresh Visible'}
          </ActionButton>
          {downloadFolderPaths.map((folder) => (
            <ActionButton key={folder} size="xs" tone={submittedSearch.query === folder ? 'primary' : 'default'} onClick={() => {
              setQuery(folder)
              setSubmittedSearch({ query: folder, submittedAt: Date.now() })
            }}>
              {folder}
            </ActionButton>
          ))}
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          Queue {status.queueBackend} · depth {status.queueDepth ?? 0} · waiting {status.importPendingCount ?? 0} · running {status.importProcessingCount ?? 0} · errors {status.importErrorCount ?? 0}
        </div>
      </ViewSection>

      <ViewSection title="Download Files" subtitle="Compact import queue from configured download roots." className="p-0" bodyClassName="mt-0">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.filename}
          loading={isLoading}
          loadingMessage="Loading…"
          emptyMessage="No files in configured download folders. Update env and sync."
          onRowClick={(row) => navigate(`/import/review?filename=${encodeURIComponent(row.filename)}`)}
          tableClassName="min-w-[1060px]"
          rowClassName={(row) =>
            player.track?.filename === row.filename ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/20'
          }
          className="rounded-none border-0"
        />
      </ViewSection>

      {queueMessage ? <Notice>{queueMessage}</Notice> : null}
      {errorMessage || status.lastError ? (
        <Notice tone="error" className="text-sm">
          {errorMessage ?? status.lastError}
        </Notice>
      ) : null}
    </div>
  )
}

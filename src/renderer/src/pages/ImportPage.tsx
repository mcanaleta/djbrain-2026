import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLinkIcon, OpenInNewWindowIcon, PauseIcon, PlayIcon, TrashIcon } from '@radix-ui/react-icons'
import type { ImportFileResult } from '../../../shared/api'
import { ActionButton, DataTable, LabeledInput, Notice, ViewSection, type DataTableColumn } from '../components/view'
import { usePlayer, localFileUrl } from '../context/PlayerContext'
import {
  deriveTrackSummaryFromFilename,
  formatCompactDuration,
  formatFileSize
} from '../lib/music-file'

type CollectionItem = {
  filename: string
  filesize: number
  duration: number | null
}

type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

type RowImportState =
  | { status: 'idle' }
  | { status: 'importing' }
  | { status: 'imported'; dest: string }
  | { status: 'imported_upgrade'; dest: string; existing: string }
  | { status: 'skipped'; existing: string }
  | { status: 'needs_review' }
  | { status: 'error'; message: string }

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Unexpected import list error'
}

function importStateLabel(state: RowImportState): React.JSX.Element | null {
  if (state.status === 'idle') return null
  if (state.status === 'importing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
        Importing…
      </span>
    )
  }
  if (state.status === 'imported') {
    return (
      <span className="text-xs text-emerald-400" title={state.dest}>
        ✓ Imported
      </span>
    )
  }
  if (state.status === 'imported_upgrade') {
    return (
      <span className="text-xs text-sky-400" title={`Saved as: ${state.dest}`}>
        ↑ Upgraded
      </span>
    )
  }
  if (state.status === 'skipped') {
    return (
      <span className="text-xs text-zinc-500" title={`Already at: ${state.existing}`}>
        — Already have it
      </span>
    )
  }
  if (state.status === 'needs_review') {
    return <span className="text-xs text-amber-400">? No Discogs match</span>
  }
  if (state.status === 'error') {
    return (
      <span className="max-w-[14rem] truncate text-xs text-red-400" title={state.message}>
        ✗ {state.message}
      </span>
    )
  }
  return null
}

type ImportRow = CollectionItem & {
  artist: string
  title: string
  year: string
}

export default function ImportPage(): React.JSX.Element {
  const player = usePlayer()
  const [musicFolderPath, setMusicFolderPath] = useState<string>('')

  const [query, setQuery] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState({ query: '', submittedAt: 0 })
  const [items, setItems] = useState<CollectionItem[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)
  const [importStates, setImportStates] = useState<Map<string, RowImportState>>(new Map())
  const [isClearingFolders, setIsClearingFolders] = useState(false)
  const [clearFoldersResult, setClearFoldersResult] = useState<string | null>(null)

  const latestQueryRef = useRef(submittedSearch.query)
  const requestIdRef = useRef(0)
  latestQueryRef.current = submittedSearch.query

  useEffect(() => {
    window.api.settings.get().then((snap) => {
      setMusicFolderPath(snap.settings.musicFolderPath)
    }).catch(() => {})
  }, [])

  const loadItems = useCallback(async (searchQuery: string): Promise<void> => {
    const requestId = ++requestIdRef.current
    setIsLoading(true)
    try {
      const result = await window.api.collection.listDownloads(searchQuery)
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
    window.api.collection.getStatus().then((s) => { if (active) setStatus(s) }).catch(() => {})
    const unsub = window.api.collection.onUpdated((s) => {
      if (!active) return
      setStatus(s)
      void loadItems(latestQueryRef.current)
    })
    return () => { active = false; unsub() }
  }, [loadItems])

  useEffect(() => {
    void loadItems(submittedSearch.query)
  }, [loadItems, submittedSearch.query, submittedSearch.submittedAt])

  const handleSyncNow = async (): Promise<void> => {
    try {
      setStatus(await window.api.collection.syncNow())
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

  const handleImport = async (filename: string): Promise<void> => {
    setImportStates((prev) => new Map(prev).set(filename, { status: 'importing' }))
    try {
      const result: ImportFileResult = await window.api.collection.importFile(filename)
      setImportStates((prev) => {
        const next = new Map(prev)
        if (result.status === 'imported') {
          next.set(filename, { status: 'imported', dest: result.destRelativePath })
        } else if (result.status === 'imported_upgrade') {
          next.set(filename, {
            status: 'imported_upgrade',
            dest: result.destRelativePath,
            existing: result.existingRelativePath
          })
        } else if (result.status === 'skipped_existing') {
          next.set(filename, { status: 'skipped', existing: result.existingRelativePath })
        } else if (result.status === 'needs_review') {
          next.set(filename, { status: 'needs_review' })
        } else if (result.status === 'error') {
          next.set(filename, { status: 'error', message: result.message })
        }
        return next
      })
    } catch (error) {
      setImportStates((prev) =>
        new Map(prev).set(filename, {
          status: 'error',
          message: error instanceof Error ? error.message : 'Import failed'
        })
      )
    }
  }

  const handleDeleteFile = async (filename: string): Promise<void> => {
    try {
      await window.api.collection.deleteFile(filename)
      // Optimistically remove from local list; sync will confirm
      setItems((prev) => prev.filter((i) => i.filename !== filename))
      setTotal((prev) => prev - 1)
      setImportStates((prev) => { const next = new Map(prev); next.delete(filename); return next })
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const handleShowInFinder = (filename: string): void => {
    void window.api.collection.showInFinder(filename)
  }

  const handleOpenInPlayer = (filename: string): void => {
    void window.api.collection.openInPlayer(filename)
  }

  const handleClearEmptyFolders = async (): Promise<void> => {
    setIsClearingFolders(true)
    setClearFoldersResult(null)
    try {
      const count = await window.api.collection.clearEmptyFolders()
      setClearFoldersResult(count === 0 ? 'No empty folders found.' : `Removed ${count} empty folder${count === 1 ? '' : 's'}.`)
    } catch (error) {
      setClearFoldersResult(`Error: ${formatError(error)}`)
    } finally {
      setIsClearingFolders(false)
    }
  }

  const rows = useMemo(
    () => items.map((item) => ({ ...item, ...deriveTrackSummaryFromFilename(item.filename) })),
    [items]
  )

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
            onClick={() => handlePlay(row)}
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
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[240px] truncate text-zinc-100',
      render: (row) => <span title={row.title}>{row.title}</span>
    },
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[180px] truncate text-zinc-300',
      render: (row) => <span title={row.artist}>{row.artist}</span>
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-400',
      render: (row) => row.year
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
      key: 'import',
      header: 'Action',
      cellClassName: 'min-w-[150px]',
      render: (row) => {
        const importState = importStates.get(row.filename) ?? { status: 'idle' }
        const isDone =
          importState.status === 'imported' ||
          importState.status === 'imported_upgrade' ||
          importState.status === 'skipped'

        if (importState.status === 'idle') {
          return (
            <ActionButton
              type="button"
              size="xs"
              onClick={() => {
                void handleImport(row.filename)
              }}
              className="rounded px-2.5 py-0.5"
            >
              Import
            </ActionButton>
          )
        }

        if (isDone) {
          return (
            <div className="flex items-center gap-1">
              {importStateLabel(importState)}
              <button
                type="button"
                onClick={() =>
                  setImportStates((prev) => {
                    const next = new Map(prev)
                    next.delete(row.filename)
                    return next
                  })
                }
                className="ml-1 text-xs text-zinc-600 hover:text-zinc-400"
                title="Reset"
              >
                ×
              </button>
            </div>
          )
        }

        return importStateLabel(importState)
      }
    },
    {
      key: 'finder',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => (
        <button
          type="button"
          onClick={() => handleShowInFinder(row.filename)}
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
          onClick={() => handleOpenInPlayer(row.filename)}
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
          onClick={() => {
            void handleDeleteFile(row.filename)
          }}
          title="Delete file"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-red-950/40 hover:text-red-400"
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
      </ViewSection>

      <ViewSection title="Download Files" subtitle="Compact import queue from configured download roots." className="p-0" bodyClassName="mt-0">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.filename}
          loading={isLoading}
          loadingMessage="Loading…"
          emptyMessage="No files in download folders. Configure paths in Settings and sync."
          tableClassName="min-w-[1120px]"
          rowClassName={(row) =>
            player.track?.filename === row.filename ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/20'
          }
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

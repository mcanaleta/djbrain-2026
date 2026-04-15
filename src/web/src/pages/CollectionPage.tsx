import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CollectionItem, CollectionListResult, CollectionSyncStatus } from '../../../shared/api'
import { api } from '../api/client'
import { ActionButton, DataTable, LabeledInput, Notice, SourceIconLink, ViewSection, type DataTableColumn } from '../components/view'
import { getErrorMessage } from '../lib/error-utils'
import { deriveTrackSummaryFromFilename, formatCompactDuration, formatFileSize } from '../lib/music-file'

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
  format: string
  location: 'collection' | 'downloads'
  quality: string
  qualityTitle: string
  absolutePath: string
}

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected collection error')
}

function readExtension(filename: string): string {
  const match = filename.match(/(\.[^.\/]+)$/)
  return match?.[1]?.toLowerCase() ?? ''
}

function formatName(filename: string): string {
  const ext = readExtension(filename)
  return ext ? ext.slice(1).toUpperCase() : '—'
}

function joinPath(root: string, filename: string): string {
  return root ? `${root.replace(/\/+$/, '')}/${filename.replace(/^\/+/, '')}` : filename
}

function formatQuality(item: CollectionItem): { label: string; title: string } {
  const score = item.qualityScore == null ? null : Math.round(item.qualityScore)
  const label = score == null ? '—' : String(score)
  const title = score == null ? 'No audio analysis score yet' : `Analysis score ${score}/100${item.bitrateKbps != null ? ` · ${Math.round(item.bitrateKbps)}kbps` : ''}`
  return { label, title }
}

function renderBadge(label: string, className: string, title?: string): React.JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex min-w-[3.25rem] items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ${className}`}
    >
      {label}
    </span>
  )
}

function renderLocationBadge(location: CollectionRow['location']): React.JSX.Element {
  return renderBadge(
    location,
    location === 'downloads'
      ? 'bg-amber-400 text-amber-950'
      : 'bg-emerald-400 text-emerald-950'
  )
}

function renderFormatBadge(format: string): React.JSX.Element {
  const normalized = format.toLowerCase()
  return renderBadge(
    format,
    ['wav', 'flac', 'aiff', 'aif', 'alac'].includes(normalized)
      ? 'bg-sky-400 text-sky-950'
      : ['mp3', 'aac', 'm4a', 'ogg', 'opus'].includes(normalized)
        ? 'bg-fuchsia-400 text-fuchsia-950'
        : 'bg-zinc-700 text-zinc-100'
  )
}

function renderQualityBadge(quality: string, title: string): React.JSX.Element {
  const score = Number(quality)
  return renderBadge(
    quality,
    !Number.isFinite(score)
      ? 'bg-zinc-700 text-zinc-100'
      : score >= 85
        ? 'bg-emerald-400 text-emerald-950'
        : score >= 70
          ? 'bg-amber-300 text-amber-950'
          : 'bg-rose-400 text-rose-950',
    title
  )
}

function makeColumns(): DataTableColumn<CollectionRow>[] {
  return [
    {
      key: 'location',
      header: 'Location',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => renderLocationBadge(row.location)
    },
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[180px] truncate text-zinc-200',
      render: (row) => row.artist
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[280px] truncate',
      render: (row) => row.title
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-300',
      render: (row) => row.year
    },
    {
      key: 'length',
      header: 'Length',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => formatCompactDuration(row.duration)
    },
    {
      key: 'size',
      header: 'Size',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => formatFileSize(row.filesize)
    },
    {
      key: 'format',
      header: 'Format',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => renderFormatBadge(row.format)
    },
    {
      key: 'quality',
      header: 'Quality',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => renderQualityBadge(row.quality, row.qualityTitle)
    },
    {
      key: 'discogs',
      header: 'Discogs',
      cellClassName: 'w-[1%] whitespace-nowrap text-center',
      render: (row) => <SourceIconLink url={row.recordingDiscogsUrl} label="Discogs" />
    },
    {
      key: 'musicbrainz',
      header: 'MB',
      cellClassName: 'w-[1%] whitespace-nowrap text-center',
      render: (row) => <SourceIconLink url={row.recordingMusicBrainzUrl} label="MusicBrainz" />
    }
  ]
}

export default function CollectionPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [items, setItems] = useState<CollectionItem[]>([])
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)
  const [musicFolderPath, setMusicFolderPath] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const requestIdRef = useRef(0)
  const latestQueryRef = useRef(submittedQuery)

  latestQueryRef.current = submittedQuery

  const handleOpenItem = useCallback(
    (row: CollectionRow): void => {
      navigate(`/collection/item?filename=${encodeURIComponent(row.filename)}`)
    },
    [navigate]
  )

  const columns = useMemo(() => makeColumns(), [])

  const loadItems = useCallback(async (query: string): Promise<void> => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoading(true)
    try {
      const result = (await api.collection.list(query, COLLECTION_VIEW_LIMIT)) as CollectionListResult
      if (requestIdRef.current !== requestId) return
      setItems(result.items)
      setFilteredTotal(result.total)
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
    void api.settings.get().then((settings) => {
      if (active) setMusicFolderPath(settings.musicFolderPath)
    }).catch(() => {})
    void api.collection.getStatus().then((nextStatus) => {
      if (active) setStatus(nextStatus)
    }).catch((error) => {
      if (active) setErrorMessage(formatError(error))
    })
    const unsubscribe = api.collection.onUpdated((nextStatus) => {
      if (!active) return
      setStatus(nextStatus)
      void loadItems(latestQueryRef.current)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [loadItems])

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

  const rows = useMemo(
    () =>
      items.map((item) => {
        const fallback = deriveTrackSummaryFromFilename(item.filename)
        const title = item.recordingCanonical?.title
          ? `${item.recordingCanonical.title}${item.recordingCanonical.version ? ` (${item.recordingCanonical.version})` : ''}`
          : item.importTitle
            ? `${item.importTitle}${item.importVersion ? ` (${item.importVersion})` : ''}`
            : fallback.title
        const quality = formatQuality(item)
        return {
          ...item,
          artist: item.recordingCanonical?.artist || item.importArtist || fallback.artist,
          title,
          year: item.recordingCanonical?.year || item.importYear || fallback.year,
          format: formatName(item.filename),
          location: item.isDownload ? ('downloads' as const) : ('collection' as const),
          quality: quality.label,
          qualityTitle: quality.title,
          absolutePath: joinPath(musicFolderPath, item.filename)
        }
      }),
    [items, musicFolderPath]
  )

  const statusText = status.lastSyncedAt
    ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`
    : 'Not synced yet'

  return (
    <div className="space-y-4">
      <ViewSection
        title="Collection"
        subtitle="Local tracks indexed from your collection."
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
        subtitle="Search matches against indexed collection metadata and filenames."
        borderless
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
          rows={rows}
          getRowKey={(row) => row.filename}
          getRowTitle={(row) => row.absolutePath}
          onRowClick={handleOpenItem}
          loading={isLoading}
          loadingMessage="Loading collection…"
          emptyMessage="No tracks found. Use Sync Now after configuring folders."
          tableClassName="min-w-[1120px]"
          borderless
          className="rounded-none bg-transparent"
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

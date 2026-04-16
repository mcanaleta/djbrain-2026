import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { CollectionItem } from '../../../shared/api'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { FormatBadge } from '../components/view/FormatBadge'
import { LabeledInput } from '../components/view/LabeledInput'
import { LocationBadge } from '../components/view/LocationBadge'
import { Notice } from '../components/view/Notice'
import { QualityBadge } from '../components/view/QualityBadge'
import { SourceIconLink } from '../components/view/SourceIconLink'
import { ViewSection } from '../components/view/ViewSection'
import { COLLECTION_LIST_QUERY_KEY, useCollectionStatusQuery } from '../hooks/useCollectionStatusQuery'
import { useSettingsQuery } from '../hooks/useSettingsQuery'
import { getErrorMessage } from '../lib/error-utils'
import { deriveTrackSummaryFromFilename, formatCompactDuration, formatExtensionName, formatFileSize, formatQualityScore, joinPath } from '../lib/music-file'

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

function makeColumns(): DataTableColumn<CollectionRow>[] {
  return [
    {
      key: 'location',
      header: 'Location',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <LocationBadge location={row.location} />
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
      render: (row) => <FormatBadge format={row.format} />
    },
    {
      key: 'quality',
      header: 'Quality',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <QualityBadge quality={row.quality} title={row.qualityTitle} />
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
  const [searchDraft, setSearchDraft] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const handleOpenItem = useCallback(
    (row: CollectionRow): void => {
      navigate(`/collection/item?filename=${encodeURIComponent(row.filename)}`)
    },
    [navigate]
  )

  const columns = useMemo(() => makeColumns(), [])

  const { data: settings } = useSettingsQuery()
  const { data: status, error: statusError } = useCollectionStatusQuery(COLLECTION_LIST_QUERY_KEY)

  const {
    data: listResult,
    error: listError,
    isPending: isLoading
  } = useQuery({
    queryKey: [...COLLECTION_LIST_QUERY_KEY, submittedQuery, COLLECTION_VIEW_LIMIT],
    queryFn: () => api.collection.list(submittedQuery, COLLECTION_VIEW_LIMIT)
  })

  const handleSyncNow = async (): Promise<void> => {
    setActionError(null)
    try {
      await api.collection.syncNow()
    } catch (error) {
      setActionError(formatError(error))
    }
  }

  const items = listResult?.items ?? []
  const filteredTotal = listResult?.total ?? 0
  const musicFolderPath = settings?.musicFolderPath ?? ''
  const errorMessage = actionError ?? (listError ? formatError(listError) : statusError ? formatError(statusError) : null)

  const rows = useMemo(
    () =>
      items.map((item) => {
        const fallback = deriveTrackSummaryFromFilename(item.filename)
        const title = item.recordingCanonical?.title
          ? `${item.recordingCanonical.title}${item.recordingCanonical.version ? ` (${item.recordingCanonical.version})` : ''}`
          : item.importTitle
            ? `${item.importTitle}${item.importVersion ? ` (${item.importVersion})` : ''}`
            : fallback.title
        const quality = formatQualityScore(item.qualityScore, item.bitrateKbps)
        return {
          ...item,
          artist: item.recordingCanonical?.artist || item.importArtist || fallback.artist,
          title,
          year: item.recordingCanonical?.year || item.importYear || fallback.year,
          format: formatExtensionName(item.filename),
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

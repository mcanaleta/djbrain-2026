import { useCallback, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { CollectionItem } from '@djbrain/shared/api'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { Notice } from '../components/view/Notice'
import { Pill } from '../components/view/Pill'
import { QueryBar } from '../components/view/QueryBar'
import { ViewSection } from '../components/view/ViewSection'
import { storeIdentifyIteration } from '../features/identify/iteration'
import { deriveTrackSummaryFromFilename } from '../lib/music-file'
import { withVersion } from '../lib/importReview'
import { buildIdentifyReviewHref } from '../lib/urls'

type Scope = 'downloads' | 'collection'
type VerifyFilter = 'all' | 'verified' | 'unverified'

const STATUS_RANK: Record<string, number> = {
  needs_review: 0,
  error: 1,
  ready: 2,
  processing: 3,
  pending: 4
}

function readScope(value: string | null): Scope {
  return value === 'collection' ? 'collection' : 'downloads'
}

function readFilter(value: string | null): VerifyFilter {
  return value === 'all' || value === 'verified' ? value : 'unverified'
}

function trackLabel(row: CollectionItem): { artist: string; title: string; year: string } {
  const fallback = deriveTrackSummaryFromFilename(row.filename)
  return {
    artist: row.recordingCanonical?.artist ?? row.importArtist ?? fallback.artist,
    title: row.recordingCanonical?.title
      ? withVersion(row.recordingCanonical.title, row.recordingCanonical.version)
      : row.importTitle
        ? withVersion(row.importTitle, row.importVersion)
        : fallback.title,
    year: row.recordingCanonical?.year ?? row.importYear ?? fallback.year
  }
}

export default function IdentifyPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const scope = readScope(params.get('scope'))
  const query = params.get('query') ?? ''
  const filter = readFilter(params.get('filter'))

  const setRoute = useCallback(
    (next: Partial<{ scope: Scope; query: string; filter: VerifyFilter }>) => {
      const search = new URLSearchParams(params)
      if (next.scope) search.set('scope', next.scope)
      if (typeof next.query === 'string') search.set('query', next.query)
      if (next.filter) {
        if (next.filter === 'unverified') search.delete('filter')
        else search.set('filter', next.filter)
      }
      setParams(search, { replace: true })
    },
    [params, setParams]
  )

  const {
    data: listResult,
    error,
    isPending,
    isFetching,
    refetch
  } = useQuery({
    queryKey: ['identify', scope, query],
    queryFn: () => (scope === 'downloads' ? api.collection.listDownloads(query) : api.collection.list(query, 400))
  })

  const rows = useMemo(
    () =>
      (listResult?.items ?? [])
        .filter((row) => (scope === 'downloads' ? Boolean(row.isDownload) && row.recordingId == null : !row.isDownload && Boolean(row.identificationStatus)))
        .filter((row) =>
          filter === 'all'
            ? true
            : filter === 'verified'
              ? Boolean(row.identificationVerifiedAt)
              : !row.identificationVerifiedAt
        )
        .sort((left, right) => {
          const statusDelta = (STATUS_RANK[left.identificationStatus ?? ''] ?? 9) - (STATUS_RANK[right.identificationStatus ?? ''] ?? 9)
          if (statusDelta !== 0) return statusDelta
          return (right.identificationConfidence ?? -1) - (left.identificationConfidence ?? -1)
        }),
    [filter, listResult, scope]
  )
  useEffect(() => {
    storeIdentifyIteration(scope, query, filter, rows.map((row) => row.id))
  }, [filter, query, rows, scope])
  const errorMessage = error instanceof Error ? error.message : error ? 'Failed to load identification queue' : null

  const columns = useMemo<DataTableColumn<CollectionItem>[]>(
    () => [
      {
        key: 'status',
        header: 'Status',
        cellClassName: 'w-[1%] whitespace-nowrap',
        render: (row) => <Pill tone={row.identificationStatus === 'needs_review' ? 'primary' : 'muted'}>{row.identificationStatus ?? '—'}</Pill>
      },
      {
        key: 'artist',
        header: 'Artist',
        cellClassName: 'max-w-[140px] truncate',
        render: (row) => trackLabel(row).artist
      },
      {
        key: 'title',
        header: 'Title',
        cellClassName: 'max-w-[220px] truncate',
        render: (row) => trackLabel(row).title
      },
      {
        key: 'year',
        header: 'Year',
        cellClassName: 'w-[1%] whitespace-nowrap text-zinc-400',
        render: (row) => trackLabel(row).year
      }
    ],
    []
  )

  return (
    <ViewSection
      padding="sm"
      title="Files Identification"
      subtitle="Review identified files, confirm the right recording, or fix it manually."
      aside={<ActionButton size="xs" onClick={() => navigate('/collection')}>Collection</ActionButton>}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <ActionButton size="xs" tone={scope === 'downloads' ? 'primary' : 'default'} onClick={() => setRoute({ scope: 'downloads' })}>
            Downloads
          </ActionButton>
          <ActionButton size="xs" tone={scope === 'collection' ? 'primary' : 'default'} onClick={() => setRoute({ scope: 'collection' })}>
            Collection
          </ActionButton>
          <ActionButton size="xs" tone={filter === 'unverified' ? 'primary' : 'default'} onClick={() => setRoute({ filter: 'unverified' })}>
            Unverified
          </ActionButton>
          <ActionButton size="xs" tone={filter === 'verified' ? 'primary' : 'default'} onClick={() => setRoute({ filter: 'verified' })}>
            Verified
          </ActionButton>
          <ActionButton size="xs" tone={filter === 'all' ? 'primary' : 'default'} onClick={() => setRoute({ filter: 'all' })}>
            All
          </ActionButton>
        </div>
        <QueryBar
          label="Search"
          value={query}
          onChange={(value) => setRoute({ query: value })}
          onSubmit={() => void refetch()}
          buttonLabel="Refresh"
          busyLabel="Loading…"
          isBusy={isFetching}
        />
        {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
        <DataTable
          columns={columns}
          rows={rows}
          loading={isPending}
          emptyMessage="No identified files."
          getRowKey={(row) => String(row.id)}
          getRowTitle={(row) => row.filename}
          onRowClick={(row) => navigate(buildIdentifyReviewHref(row.id, scope, query, filter))}
        />
      </div>
    </ViewSection>
  )
}

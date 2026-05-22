import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { RecordingSummary } from '@djbrain/shared/api'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { LabeledInput } from '../components/view/LabeledInput'
import { Notice } from '../components/view/Notice'
import { ViewSection } from '../components/view/ViewSection'
import { formatCompactDuration } from '../lib/music-file'
import { buildRecordingHref } from '../lib/urls'

const RECORDING_COLUMNS: DataTableColumn<RecordingSummary>[] = [
  {
    key: 'id',
    header: 'Id',
    cellClassName: 'w-[1%] whitespace-nowrap text-zinc-500',
    render: (recording) => recording.id
  },
  {
    key: 'artist',
    header: 'Artist',
    cellClassName: 'max-w-[220px] truncate text-zinc-200',
    render: (recording) => recording.canonical.artist ?? '—'
  },
  {
    key: 'title',
    header: 'Title',
    cellClassName: 'max-w-[280px] truncate text-zinc-100',
    render: (recording) =>
      `${recording.canonical.title ?? '—'}${recording.canonical.version ? ` (${recording.canonical.version})` : ''}`
  },
  {
    key: 'year',
    header: 'Year',
    cellClassName: 'whitespace-nowrap text-zinc-500',
    render: (recording) => recording.canonical.year ?? '—'
  },
  {
    key: 'length',
    header: 'Length',
    cellClassName: 'whitespace-nowrap text-zinc-500',
    render: (recording) => formatCompactDuration(recording.durationSeconds)
  },
  {
    key: 'review',
    header: 'Review',
    cellClassName: 'whitespace-nowrap text-zinc-500',
    render: (recording) => recording.reviewState
  },
  {
    key: 'files',
    header: 'Files',
    cellClassName: 'whitespace-nowrap text-zinc-500',
    render: (recording) => recording.fileCount
  },
  {
    key: 'claims',
    header: 'Claims',
    cellClassName: 'whitespace-nowrap text-zinc-500',
    render: (recording) => recording.claimCount
  }
]

export default function RecordingsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const { data: recordings = [], isPending, error } = useQuery({
    queryKey: ['collection', 'recordings', submittedQuery],
    queryFn: () => api.collection.listRecordings(submittedQuery)
  })
  const errorMessage = error instanceof Error ? error.message : error ? 'Failed to load recordings' : null

  return (
    <div className="space-y-4">
      <ViewSection
        title="Recordings"
        subtitle="Canonical recording entities and their attached files."
        aside={<div className="text-[11px] text-zinc-500">{recordings.length} rows</div>}
        borderless
        className="space-y-3 p-0"
        bodyClassName="mt-0"
      >
        <form
          className="flex flex-wrap items-end gap-2 border-b border-zinc-800 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            setSubmittedQuery(query.trim())
          }}
        >
          <LabeledInput
            label="Search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Artist, title…"
            className="min-w-[220px] flex-1"
          />
          <ActionButton type="submit" size="xs" tone="primary">Search</ActionButton>
        </form>
        <DataTable
          columns={RECORDING_COLUMNS}
          rows={recordings}
          getRowKey={(recording) => String(recording.id)}
          loading={isPending}
          loadingMessage="Loading…"
          emptyMessage="No recordings found."
          onRowClick={(recording) => navigate(buildRecordingHref(recording.id))}
          tableClassName="min-w-[900px]"
          className="rounded-none border-0"
        />
      </ViewSection>
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
    </div>
  )
}

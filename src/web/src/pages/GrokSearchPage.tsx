import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { GrokTrackResult } from '../../../shared/grok-search'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { LabeledInput } from '../components/view/LabeledInput'
import { Notice } from '../components/view/Notice'
import { ViewSection } from '../components/view/ViewSection'
import { useSettingsQuery } from '../hooks/useSettingsQuery'

const GROK_COLUMNS: DataTableColumn<GrokTrackResult>[] = [
  {
    key: 'artist',
    header: 'Artist',
    cellClassName: 'text-zinc-200',
    render: (track) => track.artist
  },
  {
    key: 'title',
    header: 'Title',
    cellClassName: 'text-zinc-100',
    render: (track) => track.title
  },
  {
    key: 'version',
    header: 'Version',
    cellClassName: 'text-zinc-300',
    render: (track) => track.version || '—'
  },
  {
    key: 'year',
    header: 'Year',
    cellClassName: 'text-zinc-300',
    render: (track) => track.year || '—'
  }
]

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected Grok search error'
}

export default function GrokSearchPage(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const { data: settings, error: settingsError, isPending: isLoadingSettings } = useSettingsQuery()
  const hasConfig = Boolean(settings?.grokApiKey.trim())
  const {
    data: results,
    error: searchError,
    isFetching: isSearching,
    refetch
  } = useQuery({
    queryKey: ['grok-search', submittedQuery],
    queryFn: () => api.grokSearch.search(submittedQuery),
    enabled: Boolean(submittedQuery) && hasConfig
  })
  const errorMessage = actionError ?? (settingsError ? formatError(settingsError) : searchError ? formatError(searchError) : null)

  const submitSearch = (): void => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) return
    if (!hasConfig) {
      setActionError('Set DJBRAIN_GROK_API_KEY before searching.')
      return
    }
    setActionError(null)
    if (trimmedQuery === submittedQuery) void refetch()
    else setSubmittedQuery(trimmedQuery)
  }

  const rows = useMemo(() => results?.tracks ?? [], [results])

  return (
    <div className="space-y-4">
      <ViewSection title="Grok Music Search" subtitle="Search online music with Grok and extract structured track rows.">
        <div className="flex items-end gap-2">
          <LabeledInput
            label="Search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') {
                return
              }
              event.preventDefault()
              submitSearch()
            }}
            placeholder="Search tracks (artist, label, genre, era)..."
            className="flex-1"
            inputClassName="h-9 rounded-md border-zinc-800 bg-zinc-950/30"
          />
          <ActionButton
            type="button"
            onClick={() => {
              submitSearch()
            }}
            disabled={isSearching || isLoadingSettings || !query.trim()}
          >
            {isSearching ? 'Searching…' : 'Search'}
          </ActionButton>
        </div>

        {!hasConfig && !isLoadingSettings ? (
          <Notice tone="warning" className="mt-3 text-sm">
            Set `DJBRAIN_GROK_API_KEY` before searching.
          </Notice>
        ) : null}
      </ViewSection>

      {errorMessage ? <Notice tone="error" className="text-sm">{errorMessage}</Notice> : null}

      <ViewSection
        title="Results"
        subtitle={results ? `Results for "${results.query}" · ${results.total} tracks` : 'No results yet.'}
        className="p-0"
        bodyClassName="mt-0"
      >
        <DataTable
          columns={GROK_COLUMNS}
          rows={rows}
          getRowKey={(track, index) => `${track.artist}-${track.title}-${index}`}
          loading={isSearching}
          loadingMessage="Searching…"
          emptyMessage="No tracks found."
          tableClassName="min-w-[680px]"
          className="rounded-none border-0"
        />
      </ViewSection>
    </div>
  )
}

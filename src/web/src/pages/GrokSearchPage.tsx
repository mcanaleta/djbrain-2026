import { useEffect, useMemo, useState } from 'react'
import type { GrokSearchResponse, GrokTrackResult } from '../../../shared/grok-search'
import { api } from '../api/client'
import {
  ActionButton,
  DataTable,
  LabeledInput,
  Notice,
  ViewSection,
  type DataTableColumn
} from '../components/view'

type AppSettings = {
  grokApiKey: string
}

const EMPTY_SETTINGS: AppSettings = {
  grokApiKey: ''
}

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
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GrokSearchResponse | null>(null)
  const [isLoadingSettings, setIsLoadingSettings] = useState(true)
  const [isSearching, setIsSearching] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const loadSettings = async (): Promise<void> => {
      setIsLoadingSettings(true)
      try {
        const settings = await api.settings.get()
        setSettings({
          grokApiKey: settings.grokApiKey
        })
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setIsLoadingSettings(false)
      }
    }

    void loadSettings()
  }, [])

  const hasConfig = Boolean(settings.grokApiKey.trim())

  const submitSearch = async (): Promise<void> => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      return
    }
    if (!hasConfig) {
      setErrorMessage('Set DJBRAIN_GROK_API_KEY before searching.')
      return
    }

    setIsSearching(true)
    setErrorMessage(null)
    try {
      const response = await api.grokSearch.search(trimmedQuery)
      setResults(response)
    } catch (error) {
      setResults(null)
      setErrorMessage(formatError(error))
    } finally {
      setIsSearching(false)
    }
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
              void submitSearch()
            }}
            placeholder="Search tracks (artist, label, genre, era)..."
            className="flex-1"
            inputClassName="h-9 rounded-md border-zinc-800 bg-zinc-950/30"
          />
          <ActionButton
            type="button"
            onClick={() => {
              void submitSearch()
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

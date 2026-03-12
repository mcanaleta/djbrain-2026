import { useEffect, useMemo, useState } from 'react'
import type { GrokSearchResponse, GrokTrackResult } from '../../../shared/grok-search'

type AppSettings = {
  grokApiKey: string
}

const EMPTY_SETTINGS: AppSettings = {
  grokApiKey: ''
}

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
        const snapshot = await window.api.settings.get()
        setSettings({
          grokApiKey: snapshot.settings.grokApiKey
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
      setErrorMessage('Configure Grok API key in Settings before searching.')
      return
    }

    setIsSearching(true)
    setErrorMessage(null)
    try {
      const response = await window.api.grokSearch.search(trimmedQuery)
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
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-sm font-semibold text-zinc-100">Grok Music Search</div>
        <div className="mt-1 text-sm text-zinc-400">
          Search online music with Grok and extract structured track rows.
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
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
            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950/30 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-700"
          />
          <button
            type="button"
            onClick={() => {
              void submitSearch()
            }}
            disabled={isSearching || isLoadingSettings || !query.trim()}
            className="inline-flex h-9 shrink-0 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSearching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {!hasConfig && !isLoadingSettings ? (
          <div className="mt-3 rounded-md border border-amber-800/70 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
            Configure Grok API key in Settings before searching.
          </div>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-200">
          {errorMessage}
        </div>
      ) : null}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-3 text-sm text-zinc-400">
          {results ? `Results for "${results.query}" · ${results.total} tracks` : 'No results yet.'}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="px-3 py-2 font-medium">Artist</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Year</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-zinc-500">
                    {isSearching ? 'Searching…' : 'No tracks found.'}
                  </td>
                </tr>
              ) : (
                rows.map((track: GrokTrackResult, index) => (
                  <tr key={`${track.artist}-${track.title}-${index}`} className="border-b border-zinc-900">
                    <td className="px-3 py-2 text-zinc-200">{track.artist}</td>
                    <td className="px-3 py-2 text-zinc-100">{track.title}</td>
                    <td className="px-3 py-2 text-zinc-300">{track.version || '—'}</td>
                    <td className="px-3 py-2 text-zinc-300">{track.year || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

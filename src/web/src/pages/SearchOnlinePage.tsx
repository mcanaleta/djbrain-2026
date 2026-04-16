import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { OnlineSearchItem } from '../../../shared/online-search'
import { api } from '../api/client'
import { EmptyState } from '../components/view/EmptyState'
import { Notice } from '../components/view/Notice'
import { ViewSection } from '../components/view/ViewSection'
import { useSettingsQuery } from '../hooks/useSettingsQuery'
import { getDiscogsRoute } from '../lib/online-search'

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Unexpected search error'
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function ResultsTable({
  items,
  onNavigate
}: {
  items: OnlineSearchItem[]
  onNavigate: (item: OnlineSearchItem) => void
}): React.JSX.Element {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
          <th className="py-2 pr-3 font-medium">Type</th>
          <th className="py-2 pr-3 font-medium">Label - Ref</th>
          <th className="py-2 pr-3 font-medium">Format</th>
          <th className="py-2 pr-3 font-medium">Artist – Title</th>
          <th className="py-2 font-medium">Year</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const candidate = item.candidates[0]
          const artist = candidate?.artist ?? candidate?.artists?.join(', ')
          const labelRef = [item.label, item.catno].filter(Boolean).join(' – ')
          const artistTitle = [artist, candidate?.title ?? item.title].filter(Boolean).join(' – ')
          return (
            <tr
              key={item.link}
              className="cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-900/40"
              onClick={() => onNavigate(item)}
            >
              <td className="py-2 pr-3 align-top text-[10px] uppercase tracking-wide text-zinc-500">
                {item.sourceType ?? ''}
              </td>
              <td className="py-2 pr-3 align-top text-zinc-400">{labelRef}</td>
              <td className="py-2 pr-3 align-top text-zinc-400">{item.format ?? ''}</td>
              <td className="py-2 pr-3 align-top text-zinc-100">{artistTitle}</td>
              <td className="py-2 align-top text-zinc-400">{candidate?.year ?? ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default function SearchOnlinePage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const submittedQuery = searchParams.get('q') ?? ''
  const [inputValue, setInputValue] = useState(submittedQuery)
  const { data: settings, error: settingsError, isPending: isLoadingSettings } = useSettingsQuery()
  const {
    data: results,
    error: searchError,
    isPending: isSearching
  } = useQuery({
    queryKey: ['online-search', 'discogs', submittedQuery],
    queryFn: () => api.onlineSearch.search(submittedQuery, 'discogs'),
    enabled: Boolean(submittedQuery) && !isLoadingSettings
  })
  const hasDiscogsToken = Boolean(settings?.discogsUserToken.trim())
  const errorMessage = settingsError ? formatError(settingsError) : searchError ? formatError(searchError) : null

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const trimmed = inputValue.trim()
    if (trimmed) setSearchParams({ q: trimmed })
  }

  return (
    <div className="space-y-4">
      <ViewSection title="Discogs Search" subtitle="Search the Discogs database.">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Artist, release, label…"
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
            autoFocus
          />
          <button
            type="submit"
            className="rounded bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
            disabled={!inputValue.trim() || isSearching}
          >
            Search
          </button>
        </form>

        {!hasDiscogsToken && !isLoadingSettings ? (
          <Notice tone="warning" className="mt-3 text-sm">
            Set `DJBRAIN_DISCOGS_USER_TOKEN` before searching.
          </Notice>
        ) : null}
      </ViewSection>

      {errorMessage ? (
        <Notice tone="error" className="text-sm">
          {errorMessage}
        </Notice>
      ) : null}

      {isSearching ? (
        <Notice>Searching…</Notice>
      ) : results ? (
        results.items.length > 0 ? (
          <ViewSection title="Results" subtitle={`${results.total} matches for "${results.query}"`}>
            <ResultsTable
              items={results.items}
              onNavigate={(item) => {
                const route = getDiscogsRoute(item)
                if (route) navigate(route)
                else openExternal(item.link)
              }}
            />
          </ViewSection>
        ) : (
          <EmptyState message={`No results found for \`${results.query}\`.`} />
        )
      ) : submittedQuery ? null : (
        <EmptyState message="Enter a query above and press Search." />
      )}
    </div>
  )
}

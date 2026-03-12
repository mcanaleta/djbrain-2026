import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { buildDiscogsEntityPath, type DiscogsEntityType } from '../../../shared/discogs'
import type {
  OnlineSearchCandidate,
  OnlineSearchItem,
  OnlineSearchResponse,
  OnlineSearchSource
} from '../../../shared/online-search'
import type { AppShellOutletContext } from '../layout/AppShell'

type AppSettings = {
  discogsUserToken: string
  serperApiKey: string
}

const EMPTY_SETTINGS: AppSettings = {
  discogsUserToken: '',
  serperApiKey: ''
}

const SOURCE_LABELS: Record<OnlineSearchSource, string> = {
  discogs: 'Discogs',
  beatport: 'Beatport',
  spotify: 'Spotify',
  applemusic: 'Apple Music',
  youtube: 'YouTube',
  unknown: 'Unknown'
}

const SOURCE_STYLES: Record<OnlineSearchSource, string> = {
  discogs: 'border-amber-700/70 bg-amber-950/30 text-amber-200',
  beatport: 'border-emerald-700/70 bg-emerald-950/30 text-emerald-200',
  spotify: 'border-green-700/70 bg-green-950/30 text-green-200',
  applemusic: 'border-orange-700/70 bg-orange-950/30 text-orange-200',
  youtube: 'border-red-700/70 bg-red-950/30 text-red-200',
  unknown: 'border-zinc-700 bg-zinc-950/40 text-zinc-300'
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected online search error'
}

function formatCandidate(candidate: OnlineSearchCandidate): string {
  const artist = candidate.artist ?? candidate.artists?.join(', ') ?? 'Unknown artist'
  const version = candidate.version ? ` (${candidate.version})` : ''
  const year = candidate.year ? ` · ${candidate.year}` : ''
  return `${artist} - ${candidate.title}${version}${year}`
}

function summarizeItem(item: OnlineSearchItem): string {
  if (item.candidates.length > 0) {
    return item.candidates.slice(0, 2).map(formatCandidate).join(' | ')
  }

  return item.snippet
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function getDiscogsRoute(item: OnlineSearchItem): string | null {
  if (item.source !== 'discogs') {
    return null
  }

  const match = item.link.match(/discogs\.com\/(?:[^/]+\/)?(release|artist|label|master)\/(\d+)/i)
  if (!match) {
    return null
  }

  return buildDiscogsEntityPath(match[1].toLowerCase() as DiscogsEntityType, match[2])
}

function ResultCard({
  item,
  onNavigate
}: {
  item: OnlineSearchItem
  onNavigate?: () => void
}): React.JSX.Element {
  const summary = summarizeItem(item)

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-950/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 overflow-hidden">
            <span
              className={`inline-flex shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium uppercase tracking-wide ${SOURCE_STYLES[item.source]}`}
            >
              {SOURCE_LABELS[item.source]}
            </span>
            {item.sourceType ? (
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-zinc-500">
                {item.sourceType}
              </span>
            ) : null}
            <div className="min-w-0 truncate text-sm font-semibold text-zinc-100">{item.title}</div>
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">
            {summary || item.displayLink || item.link}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {onNavigate ? (
            <button
              type="button"
              onClick={onNavigate}
              className="inline-flex h-8 items-center rounded-md border border-amber-700/60 bg-amber-950/30 px-3 text-sm text-amber-100 hover:bg-amber-950/50"
            >
              View
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              openExternal(item.link)
            }}
            className="inline-flex h-8 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
          >
            Open
          </button>
        </div>
      </div>
    </article>
  )
}

export default function SearchOnlinePage(): React.JSX.Element {
  const { submittedSearch } = useOutletContext<AppShellOutletContext>()
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS)
  const [results, setResults] = useState<OnlineSearchResponse | null>(null)
  const [isLoadingSettings, setIsLoadingSettings] = useState(true)
  const [isSearching, setIsSearching] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const loadSettings = async (): Promise<void> => {
      setIsLoadingSettings(true)
      try {
        const snapshot = await window.api.settings.get()
        setSettings({
          discogsUserToken: snapshot.settings.discogsUserToken,
          serperApiKey: snapshot.settings.serperApiKey
        })
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setIsLoadingSettings(false)
      }
    }

    void loadSettings()
  }, [])

  const hasDiscogsConfig = Boolean(settings.discogsUserToken.trim())
  const hasSerperConfig = Boolean(settings.serperApiKey.trim())
  const trimmedQuery = submittedSearch.query.trim()
  const isDiscogsScope = submittedSearch.scope === 'discogs'
  const isOnlineScope = submittedSearch.scope === 'online' || isDiscogsScope
  const hasRequiredConfig = isDiscogsScope ? hasDiscogsConfig : hasSerperConfig

  useEffect(() => {
    if (!isOnlineScope) {
      setResults(null)
      setErrorMessage(null)
      setIsSearching(false)
      return
    }

    if (!trimmedQuery) {
      setResults(null)
      setErrorMessage(null)
      setIsSearching(false)
      return
    }

    if (isLoadingSettings) {
      return
    }

    if (!hasRequiredConfig) {
      setResults(null)
      setErrorMessage(null)
      setIsSearching(false)
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsSearching(true)
    setErrorMessage(null)

    void window.api.onlineSearch
      .search(trimmedQuery, isDiscogsScope ? 'discogs' : 'online')
      .then((response) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        setResults(response)
      })
      .catch((error) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        setResults(null)
        setErrorMessage(formatError(error))
      })
      .finally(() => {
        if (requestIdRef.current === requestId) {
          setIsSearching(false)
        }
      })
  }, [
    hasRequiredConfig,
    isDiscogsScope,
    isLoadingSettings,
    isOnlineScope,
    submittedSearch.submittedAt,
    trimmedQuery
  ])

  const visibleResults = useMemo(() => {
    if (!results) {
      return null
    }

    if (!isDiscogsScope) {
      return results
    }

    const items = results.items.filter((item) => item.source === 'discogs')
    return {
      ...results,
      items,
      total: items.length,
      sourceCounts: items.reduce<Record<OnlineSearchSource, number>>(
        (counts, item) => {
          counts[item.source] = (counts[item.source] ?? 0) + 1
          return counts
        },
        {} as Record<OnlineSearchSource, number>
      )
    }
  }, [isDiscogsScope, results])

  const sourceCountEntries = Object.entries(visibleResults?.sourceCounts ?? {}).sort(
    (left, right) => {
      return right[1] - left[1]
    }
  ) as Array<[OnlineSearchSource, number]>

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-sm font-semibold text-zinc-100">
          {isDiscogsScope ? 'Search Discogs' : 'Search Online'}
        </div>
        <div className="mt-1 text-sm text-zinc-400">
          {isDiscogsScope
            ? 'The global top search submitted a Discogs API search.'
            : 'The global top search submitted a Serper web search across indexed sources.'}
        </div>

        <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-sm text-zinc-300">
          Query: {trimmedQuery || 'Type in the top search bar and choose a search target.'}
        </div>

        {!hasRequiredConfig && !isLoadingSettings ? (
          <div className="mt-3 rounded-md border border-amber-800/70 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
            {isDiscogsScope
              ? 'Configure the Discogs user token in Settings before using Discogs search.'
              : 'Configure the Serper API key in Settings before using online search.'}
          </div>
        ) : null}

        {visibleResults ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {sourceCountEntries.map(([source, count]) => (
              <div
                key={source}
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${SOURCE_STYLES[source]}`}
              >
                {SOURCE_LABELS[source]}: {count}
              </div>
            ))}
            <div className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-950/40 px-3 py-1 text-xs text-zinc-300">
              Total: {visibleResults.total}
            </div>
          </div>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-200">
          {errorMessage}
        </div>
      ) : null}

      {isSearching ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          Searching…
        </div>
      ) : visibleResults ? (
        visibleResults.items.length > 0 ? (
          <div className="space-y-3">
            {visibleResults.items.map((item) => (
              <ResultCard
                key={item.link}
                item={item}
                onNavigate={
                  getDiscogsRoute(item)
                    ? () => {
                        navigate(getDiscogsRoute(item)!)
                      }
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
            No results found for `{visibleResults.query}`.
          </div>
        )
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          {trimmedQuery
            ? 'Run a Discogs or online search from the global top bar.'
            : 'Use the fixed top search bar to search online results.'}
        </div>
      )}
    </div>
  )
}

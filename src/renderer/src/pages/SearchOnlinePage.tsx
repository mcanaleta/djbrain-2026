import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type {
  OnlineSearchItem,
  OnlineSearchResponse,
  OnlineSearchSource
} from '../../../shared/online-search'
import { ActionButton, EmptyState, ItemRow, Notice, Pill, ViewPanel, ViewSection } from '../components/view'
import {
  getDiscogsRoute,
  ONLINE_SOURCE_LABELS,
  summarizeOnlineResult
} from '../lib/online-search'
import type { AppShellOutletContext } from '../layout/AppShell'

type AppSettings = {
  discogsUserToken: string
  serperApiKey: string
}

const EMPTY_SETTINGS: AppSettings = {
  discogsUserToken: '',
  serperApiKey: ''
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

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function ResultCard({
  item,
  onNavigate
}: {
  item: OnlineSearchItem
  onNavigate?: () => void
}): React.JSX.Element {
  return (
    <ItemRow
      title={item.title}
      subtitle={summarizeOnlineResult(item)}
      badges={
        <>
          <Pill className={SOURCE_STYLES[item.source]}>{ONLINE_SOURCE_LABELS[item.source]}</Pill>
          {item.sourceType ? <span className="text-[10px] uppercase tracking-wide text-zinc-500">{item.sourceType}</span> : null}
        </>
      }
      actions={
        <>
          {onNavigate ? (
            <ActionButton type="button" tone="primary" onClick={onNavigate}>
              View
            </ActionButton>
          ) : null}
          <ActionButton
            type="button"
            onClick={() => {
              openExternal(item.link)
            }}
          >
            Open
          </ActionButton>
        </>
      }
      className="px-4 py-3"
    />
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
      <ViewSection
        title={isDiscogsScope ? 'Search Discogs' : 'Search Online'}
        subtitle={
          isDiscogsScope
            ? 'The global top search submitted a Discogs API search.'
            : 'The global top search submitted a Serper web search across indexed sources.'
        }
      >
        <ViewPanel tone="muted" padding="sm" className="text-sm text-zinc-300">
          Query: {trimmedQuery || 'Type in the top search bar and choose a search target.'}
        </ViewPanel>

        {!hasRequiredConfig && !isLoadingSettings ? (
          <Notice tone="warning" className="mt-3 text-sm">
            {isDiscogsScope
              ? 'Configure the Discogs user token in Settings before using Discogs search.'
              : 'Configure the Serper API key in Settings before using online search.'}
          </Notice>
        ) : null}

        {visibleResults ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {sourceCountEntries.map(([source, count]) => (
              <div
                key={source}
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${SOURCE_STYLES[source]}`}
              >
                {ONLINE_SOURCE_LABELS[source]}: {count}
              </div>
            ))}
            <div className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-950/40 px-3 py-1 text-xs text-zinc-300">
              Total: {visibleResults.total}
            </div>
          </div>
        ) : null}
      </ViewSection>

      {errorMessage ? <Notice tone="error" className="text-sm">{errorMessage}</Notice> : null}

      {isSearching ? (
        <Notice>Searching…</Notice>
      ) : visibleResults ? (
        visibleResults.items.length > 0 ? (
          <ViewSection
            title="Results"
            subtitle={`${visibleResults.total} matches for "${visibleResults.query}"`}
          >
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
          </ViewSection>
        ) : (
          <EmptyState message={`No results found for \`${visibleResults.query}\`.`} />
        )
      ) : (
        <EmptyState
          message={
            trimmedQuery
              ? 'Run a Discogs or online search from the global top bar.'
              : 'Use the fixed top search bar to search online results.'
          }
        />
      )}
    </div>
  )
}

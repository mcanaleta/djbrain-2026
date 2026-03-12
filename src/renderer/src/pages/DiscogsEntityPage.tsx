import { useEffect, useState, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import type {
  DiscogsEntityDetail,
  DiscogsEntityReference,
  DiscogsEntityType
} from '../../../shared/discogs'
import {
  buildDiscogsEntityPath,
  formatDiscogsEntityType
} from '../../../shared/discogs'
import { parseTrackTitle } from '../../../shared/track-title-parser'
import type { DiscogsVideo } from '../../../shared/discogs'

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected Discogs error'
}

function extractYouTubeId(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1) || null
    }
    return url.searchParams.get('v')
  } catch {
    return null
  }
}

function VideoSection({ videos }: { videos: DiscogsVideo[] }): React.JSX.Element | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const playable = videos.filter((v) => extractYouTubeId(v.uri) !== null)
  if (playable.length === 0) return null

  const activeVideo = activeIndex !== null ? playable[activeIndex] : null
  const activeId = activeVideo ? extractYouTubeId(activeVideo.uri) : null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="text-sm font-semibold text-zinc-100">Videos</div>
      {activeId ? (
        <div className="mt-3">
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <iframe
              src={`https://www.youtube.com/embed/${activeId}?autoplay=1`}
              title={activeVideo?.title ?? 'YouTube video'}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              className="aspect-video w-full"
            />
          </div>
          {activeVideo?.title ? (
            <div className="mt-2 text-xs text-zinc-400">{activeVideo.title}</div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 space-y-1">
        {playable.map((video, index) => {
          const isActive = activeIndex === index
          return (
            <button
              key={`${video.uri}-${index}`}
              onClick={() => setActiveIndex(index === activeIndex ? null : index)}
              className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors ${
                isActive
                  ? 'border border-amber-700/40 bg-amber-950/20 text-amber-200'
                  : 'border border-transparent text-zinc-300 hover:bg-zinc-800/60'
              }`}
            >
              <span className="shrink-0 text-xs text-zinc-500">▶</span>
              <span className="truncate">{video.title || video.uri}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function RelatedLinks({
  title,
  items
}: {
  title: string
  items: DiscogsEntityReference[]
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="text-sm font-semibold text-zinc-100">{title}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {items.map((item, index) =>
          item.id ? (
            <Link
              key={`${title}-${item.type}-${item.id}-${index}`}
              to={buildDiscogsEntityPath(item.type, item.id)}
              className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
            >
              {item.name}
            </Link>
          ) : (
            <div
              key={`${title}-${item.name}-${index}`}
              className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-400"
            >
              {item.name}
            </div>
          )
        )}
      </div>
    </div>
  )
}

export default function DiscogsEntityPage({
  entityType
}: {
  entityType: DiscogsEntityType
}): React.JSX.Element {
  const { discogsId } = useParams<{ discogsId: string }>()
  const [entity, setEntity] = useState<DiscogsEntityDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [addedTrackIndices, setAddedTrackIndices] = useState<Set<number>>(new Set())

  const handleAddToWantList = useCallback(
    (trackIndex: number) => {
      if (!entity) return
      const track = entity.tracklist[trackIndex]
      if (!track) return
      const labelFact = entity.facts.find((f) => f.label === 'Labels')
      const parsed = parseTrackTitle(track.title)
      void window.api.wantList
        .add({
          artist: entity.subtitle ?? entity.title,
          title: parsed.title,
          version: parsed.version,
          length: track.duration ?? null,
          album: entity.title,
          label: labelFact?.value ?? null
        })
        .then(() => {
          setAddedTrackIndices((prev) => new Set(prev).add(trackIndex))
        })
    },
    [entity]
  )

  useEffect(() => {
    const numericId = Number(discogsId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      setEntity(null)
      setIsLoading(false)
      setErrorMessage('Discogs entity id is invalid.')
      return
    }

    let active = true
    setEntity(null)
    setIsLoading(true)
    setErrorMessage(null)

    void window.api.onlineSearch
      .getDiscogsEntity(entityType, numericId)
      .then((response) => {
        if (!active) {
          return
        }
        setEntity(response)
      })
      .catch((error) => {
        if (!active) {
          return
        }
        setEntity(null)
        setErrorMessage(formatError(error))
      })
      .finally(() => {
        if (active) {
          setIsLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [discogsId, entityType])

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300/80">
              {entity ? formatDiscogsEntityType(entity.type) : 'Discogs'}
            </div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {entity?.title ?? 'Discogs'}
            </div>
            {entity?.subtitle ? (
              <div className="mt-2 text-sm text-zinc-400">{entity.subtitle}</div>
            ) : null}
          </div>

          {entity ? (
            <a
              href={entity.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900"
            >
              Open Discogs
            </a>
          ) : null}
        </div>

        {entity?.heroImageUrl ? (
          <img
            src={entity.heroImageUrl}
            alt={entity.title}
            className="mt-4 max-h-72 w-full rounded-lg border border-zinc-800 object-cover"
          />
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-4 text-sm text-red-200">
          {errorMessage}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          Loading Discogs…
        </div>
      ) : null}

      {entity ? (
        <>
          {entity.summary ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-sm leading-7 text-zinc-300">
              {entity.summary}
            </div>
          ) : null}

          {entity.notes ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-sm leading-7 text-zinc-400">
              {entity.notes}
            </div>
          ) : null}

          {entity.facts.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {entity.facts.map((fact) => (
                <div
                  key={`${fact.label}-${fact.value}`}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4"
                >
                  <div className="text-xs uppercase tracking-wide text-zinc-500">{fact.label}</div>
                  <div className="mt-2 text-sm text-zinc-100">{fact.value}</div>
                </div>
              ))}
            </div>
          ) : null}

          {(entity.genres.length > 0 || entity.styles.length > 0) && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="flex flex-wrap gap-2">
                {entity.genres.map((genre) => (
                  <div
                    key={`genre-${genre}`}
                    className="rounded-full border border-emerald-700/50 bg-emerald-950/30 px-3 py-1 text-xs text-emerald-200"
                  >
                    {genre}
                  </div>
                ))}
                {entity.styles.map((style) => (
                  <div
                    key={`style-${style}`}
                    className="rounded-full border border-amber-700/50 bg-amber-950/30 px-3 py-1 text-xs text-amber-200"
                  >
                    {style}
                  </div>
                ))}
              </div>
            </div>
          )}

          {entity.tracklist.length > 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="text-sm font-semibold text-zinc-100">Tracklist</div>
              <div className="mt-3 divide-y divide-zinc-800">
                {entity.tracklist.map((track, index) => (
                  <div
                    key={`${track.position ?? 'track'}-${track.title}-${index}`}
                    className="grid grid-cols-[80px_1fr_80px_auto] items-center gap-3 py-3 text-sm"
                  >
                    <div className="text-zinc-500">{track.position || '—'}</div>
                    <div className="text-zinc-100">{track.title}</div>
                    <div className="text-right text-zinc-500">{track.duration || '—'}</div>
                    <div>
                      <button
                        onClick={() => handleAddToWantList(index)}
                        disabled={addedTrackIndices.has(index)}
                        className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1 text-xs text-zinc-400 hover:border-amber-600/60 hover:text-amber-300 disabled:cursor-default disabled:border-emerald-800/50 disabled:text-emerald-400"
                      >
                        {addedTrackIndices.has(index) ? 'Added' : '+ Want List'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <VideoSection videos={entity.videos} />

          {entity.relatedSections.map((section) => (
            <RelatedLinks key={section.title} title={section.title} items={section.items} />
          ))}

          {entity.urls.length > 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
              <div className="text-sm font-semibold text-zinc-100">Links</div>
              <div className="mt-3 space-y-2">
                {entity.urls.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="block break-all text-sm text-blue-300 hover:text-blue-200"
                  >
                    {url}
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

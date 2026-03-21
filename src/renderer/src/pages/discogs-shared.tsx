import { useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { DiscogsEntityReference, DiscogsTrack, DiscogsVideo } from '../../../shared/discogs'
import { buildDiscogsEntityPath } from '../../../shared/discogs'
import { parseTrackTitle } from '../../../shared/track-title-parser'
import type { MatchCandidate, ScoredCandidate } from '../../../shared/track-matcher'
import { rankCandidates, parseDurationString } from '../../../shared/track-matcher'
import type { CollectionItem } from '../../../shared/api'
import { ActionButton, ViewSection } from '../components/view'
import { getErrorMessage } from '../lib/error-utils'
import { extractYouTubeId } from '../lib/youtube'
import { deriveTrackSummaryFromFilename, fileBasename, stripExtension } from '../lib/music-file'
import { useYoutubePlayer } from '../context/YoutubePlayerContext'
import { usePlayer } from '../context/PlayerContext'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ── Score badge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }): React.JSX.Element {
  const cls =
    score >= 70
      ? 'text-emerald-400'
      : score >= 40
        ? 'text-amber-400'
        : 'text-zinc-500'
  return <span className={`w-6 shrink-0 text-right font-mono text-[10px] ${cls}`}>{score}</span>
}

// ── useTrackWantList ──────────────────────────────────────────────────────────

type WantListSource = {
  title: string
  artists: string[]
  labels?: string[]
  year?: string
  tracklist: DiscogsTrack[]
  discogsEntityId?: number
  discogsEntityType?: string
}

export function useTrackWantList(
  source: WantListSource | null,
  setError: (msg: string | null) => void
): {
  addedTrackIndices: Set<number>
  handleAddToWantList: (trackIndex: number) => void
} {
  const [addedTrackIndices, setAddedTrackIndices] = useState<Set<number>>(new Set())

  const handleAddToWantList = useCallback(
    (trackIndex: number) => {
      if (!source) return
      const track = source.tracklist[trackIndex]
      if (!track) return
      const artist = source.artists.join(', ')
      if (!artist) {
        setError('Could not determine the artist for this track.')
        return
      }
      const parsed = parseTrackTitle(track.title)
      void window.api.wantList
        .add({
          artist,
          title: parsed.title,
          version: parsed.version,
          length: track.duration ?? null,
          year: source.year ?? null,
          album: source.title,
          label: source.labels?.[0] ?? null,
          discogsReleaseId: source.discogsEntityId ?? null,
          discogsTrackPosition: track.position ?? null,
          discogsEntityType: source.discogsEntityType ?? null
        })
        .then(() => {
          setAddedTrackIndices((prev) => new Set(prev).add(trackIndex))
          setError(null)
        })
        .catch((error) => setError(getErrorMessage(error, 'Failed to add to want list')))
    },
    [source, setError]
  )

  return { addedTrackIndices, handleAddToWantList }
}

// ── Candidate helpers ─────────────────────────────────────────────────────────

function deduplicateById(candidates: MatchCandidate[]): MatchCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
}

function videosToCandidates(videos: DiscogsVideo[]): MatchCandidate[] {
  return deduplicateById(
    videos.flatMap((v) => {
      const id = extractYouTubeId(v.uri)
      if (!id) return []
      return [{ id, title: v.title || v.uri, duration: v.duration }]
    })
  )
}

function collectionToCandidates(items: CollectionItem[], tag: string): MatchCandidate[] {
  return deduplicateById(
    items.map((item) => {
      const { artist, title } = deriveTrackSummaryFromFilename(item.filename)
      const label =
        artist !== 'Unknown artist'
          ? `${artist} - ${title}`
          : stripExtension(fileBasename(item.filename))
      return { id: item.filename, title: label, duration: item.duration ?? undefined, tag }
    })
  )
}

// ── App player helper ─────────────────────────────────────────────────────────

function usePlayLocalFile(): (filename: string) => void {
  const player = usePlayer()
  return (filename: string) => {
    const { artist, title } = deriveTrackSummaryFromFilename(filename)
    player.play({
      url: `/api/media?filename=${encodeURIComponent(filename)}`,
      filename,
      title,
      artist: artist !== 'Unknown artist' ? artist : ''
    })
  }
}

// ── Expanded match list ───────────────────────────────────────────────────────

const MAX_SHOW = 10

function MatchList({
  label,
  items,
  renderAction
}: {
  label: string
  items: ScoredCandidate[]
  renderAction: (item: ScoredCandidate) => React.ReactNode
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="space-y-0.5">
        {items.slice(0, MAX_SHOW).map((item, idx) => (
          <div key={`${item.id}-${idx}`} className="flex items-center gap-1.5">
            <ScoreBadge score={item.score} />
            {renderAction(item)}
            {item.tag ? (
              <span className="shrink-0 rounded border border-zinc-700 px-1 py-px text-[9px] text-zinc-500">
                {item.tag}
              </span>
            ) : null}
            <span className="min-w-0 truncate text-zinc-400">{item.title}</span>
            {item.duration != null ? (
              <span className="ml-auto shrink-0 text-zinc-600">{formatDuration(item.duration)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tracklist ─────────────────────────────────────────────────────────────────

const MIN_SCORE_FOR_BUTTON = 30

export function Tracklist({
  tracklist,
  artists = [],
  videos = [],
  collectionItems = [],
  downloadItems = [],
  addedTrackIndices,
  onAdd
}: {
  tracklist: DiscogsTrack[]
  artists?: string[]
  videos?: DiscogsVideo[]
  collectionItems?: CollectionItem[]
  downloadItems?: CollectionItem[]
  addedTrackIndices: Set<number>
  onAdd: (index: number) => void
}): React.JSX.Element | null {
  const { activeVideoId, setActiveVideo } = useYoutubePlayer()
  const playLocalFile = usePlayLocalFile()
  const [expandedTracks, setExpandedTracks] = useState<Set<number>>(new Set())

  const artistStr = artists.join(', ')
  const videoCandidates = useMemo(() => videosToCandidates(videos), [videos])
  // list() returns everything; exclude download files so Songs = non-downloads only
  const downloadFilenames = useMemo(
    () => new Set(downloadItems.map((item) => item.filename)),
    [downloadItems]
  )
  const collectionCandidates = useMemo(
    () => [
      ...collectionToCandidates(
        collectionItems.filter((item) => !downloadFilenames.has(item.filename)),
        'Songs'
      ),
      ...collectionToCandidates(downloadItems, 'Downloads')
    ],
    [collectionItems, downloadItems, downloadFilenames]
  )
  const hasMatching = videoCandidates.length > 0 || collectionCandidates.length > 0

  const allMatches = useMemo(() => {
    return tracklist.map((track) => {
      const durationSeconds =
        track.duration ? (parseDurationString(track.duration) ?? undefined) : undefined
      const query = { title: track.title, artist: artistStr, durationSeconds }
      return {
        rankedVideos: rankCandidates(query, videoCandidates),
        rankedCollection: rankCandidates(query, collectionCandidates)
      }
    })
  }, [tracklist, artistStr, videoCandidates, collectionCandidates])

  const toggleExpand = (index: number): void => {
    setExpandedTracks((prev) => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  if (tracklist.length === 0) return null

  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Tracklist</div>
      <div className="divide-y divide-zinc-800/60">
        {tracklist.map((track, index) => {
          const { rankedVideos, rankedCollection } = allMatches[index]
          const topVideo = rankedVideos[0]?.score >= MIN_SCORE_FOR_BUTTON ? rankedVideos[0] : null
          const topCollection =
            rankedCollection[0]?.score >= MIN_SCORE_FOR_BUTTON ? rankedCollection[0] : null
          const isExpanded = expandedTracks.has(index)
          const videoIsActive = topVideo != null && activeVideoId === topVideo.id

          return (
            <div key={`${track.position ?? 'track'}-${track.title}-${index}`}>
              <div className="grid grid-cols-[32px_1fr_52px_auto] items-center gap-2 py-1.5 text-sm">
                <div className="text-zinc-500">{track.position || '—'}</div>
                <div className="text-zinc-200">{track.title}</div>
                <div className="text-right text-zinc-500">{track.duration || ''}</div>
                <div className="flex items-center gap-1">
                  {topVideo != null ? (
                    <button
                      title={topVideo.title}
                      onClick={() =>
                        setActiveVideo(videoIsActive ? null : topVideo.id, topVideo.title)
                      }
                      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition ${
                        videoIsActive
                          ? 'border-amber-700/50 bg-amber-950/30 text-amber-300'
                          : 'border-red-900/50 text-red-500 hover:border-red-700/50 hover:text-red-300'
                      }`}
                    >
                      <span>▶</span>
                      <span>YouTube</span>
                    </button>
                  ) : null}
                  {topCollection != null ? (
                    <button
                      title={topCollection.title}
                      onClick={() => playLocalFile(topCollection.id)}
                      className="flex items-center gap-1 rounded border border-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-500 transition hover:border-emerald-700/50 hover:text-emerald-300"
                    >
                      <span>▶</span>
                      <span>File</span>
                    </button>
                  ) : null}
                  {hasMatching ? (
                    <button
                      onClick={() => toggleExpand(index)}
                      className="rounded px-1 py-0.5 text-[10px] text-zinc-600 transition hover:text-zinc-300"
                    >
                      {isExpanded ? '▴' : '▾'}
                    </button>
                  ) : null}
                  <ActionButton
                    onClick={() => onAdd(index)}
                    disabled={addedTrackIndices.has(index)}
                    size="xs"
                    className="rounded px-2 py-0.5 text-zinc-400 disabled:border-emerald-800/50 disabled:text-emerald-400"
                  >
                    {addedTrackIndices.has(index) ? 'Added' : '+ Want'}
                  </ActionButton>
                </div>
              </div>
              {isExpanded ? (
                <div className="mb-2 ml-8 grid grid-cols-2 gap-x-6 text-[11px]">
                  <MatchList
                    label="YouTube"
                    items={rankedVideos}
                    renderAction={(item) => (
                      <button
                        onClick={() =>
                          setActiveVideo(
                            activeVideoId === item.id ? null : item.id,
                            item.title
                          )
                        }
                        className={`shrink-0 text-[10px] ${
                          activeVideoId === item.id
                            ? 'text-amber-300'
                            : 'text-red-500 hover:text-red-300'
                        }`}
                      >
                        ▶
                      </button>
                    )}
                  />
                  <MatchList
                    label="Local files"
                    items={rankedCollection}
                    renderAction={(item) => (
                      <button
                        onClick={() => playLocalFile(item.id)}
                        className="shrink-0 text-[10px] text-emerald-500 hover:text-emerald-300"
                      >
                        ▶
                      </button>
                    )}
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── VideoSection ──────────────────────────────────────────────────────────────

export function VideoSection({ videos }: { videos: DiscogsVideo[] }): React.JSX.Element | null {
  const { activeVideoId, setActiveVideo } = useYoutubePlayer()
  const playable = videos.filter((v) => extractYouTubeId(v.uri) !== null)
  if (playable.length === 0) return null

  return (
    <ViewSection title="Videos" className="bg-zinc-900/30">
      <div className="mt-3 space-y-1">
        {playable.map((video, index) => {
          const id = extractYouTubeId(video.uri)!
          const isActive = activeVideoId === id
          return (
            <button
              key={`${video.uri}-${index}`}
              onClick={() => setActiveVideo(isActive ? null : id, video.title)}
              className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors ${
                isActive
                  ? 'border border-amber-700/40 bg-amber-950/20 text-amber-200'
                  : 'border border-transparent text-zinc-300 hover:bg-zinc-800/60'
              }`}
            >
              <span className="shrink-0 text-xs text-zinc-500">▶</span>
              <span className="truncate">{video.title || video.uri}</span>
              {video.duration ? (
                <span className="ml-auto shrink-0 text-xs text-zinc-500">
                  {formatDuration(video.duration)}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </ViewSection>
  )
}

// ── RelatedLinks ──────────────────────────────────────────────────────────────

export function RelatedLinks({
  title,
  items
}: {
  title: string
  items: DiscogsEntityReference[]
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ViewSection title={title} className="bg-zinc-900/30">
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
    </ViewSection>
  )
}

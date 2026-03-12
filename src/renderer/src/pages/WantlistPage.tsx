import { useEffect, useState, useCallback, useRef } from 'react'
import type { WantListItem, WantListAddInput, SlskdCandidate } from '../../../preload/index'

// ─── Pipeline status helpers ─────────────────────────────────────────────────

type PipelineStatus = WantListItem['pipelineStatus']

const STATUS_LABEL: Record<PipelineStatus, string> = {
  idle: 'Pending',
  searching: 'Searching…',
  results_ready: 'Results ready',
  no_results: 'No results',
  downloading: 'Downloading…',
  downloaded: 'Downloaded',
  error: 'Error'
}

const STATUS_CLASS: Record<PipelineStatus, string> = {
  idle: 'border-zinc-700 text-zinc-400',
  searching: 'border-amber-700/60 text-amber-300',
  results_ready: 'border-emerald-700/60 text-emerald-300',
  no_results: 'border-zinc-700 text-zinc-500',
  downloading: 'border-blue-700/60 text-blue-300',
  downloaded: 'border-emerald-600/60 text-emerald-200',
  error: 'border-red-700/60 text-red-300'
}

function StatusBadge({ status }: { status: PipelineStatus }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${STATUS_CLASS[status]}`}
    >
      {(status === 'searching' || status === 'downloading') ? (
        <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {STATUS_LABEL[status]}
    </span>
  )
}

// ─── Candidate row ────────────────────────────────────────────────────────────

function fileBasename(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop() ?? filename
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000).toFixed(0)} KB`
}

function CandidateRow({
  candidate,
  onDownload,
  disabled
}: {
  candidate: SlskdCandidate
  onDownload: (c: SlskdCandidate) => void
  disabled: boolean
}): React.JSX.Element {
  const ext = candidate.extension.toUpperCase()
  const isLossless = ['FLAC', 'WAV', 'AIFF', 'AIF', 'ALAC'].includes(ext)

  return (
    <div className="flex items-center gap-3 rounded px-3 py-1.5 text-xs hover:bg-zinc-800/40">
      <span
        className={`w-6 shrink-0 text-right font-semibold ${candidate.score >= 60 ? 'text-emerald-300' : candidate.score >= 30 ? 'text-amber-300' : 'text-zinc-500'}`}
      >
        {candidate.score}
      </span>
      <span className={`w-12 shrink-0 font-mono ${isLossless ? 'text-emerald-300' : 'text-zinc-400'}`}>
        {ext}
      </span>
      <span className="w-16 shrink-0 text-zinc-500">
        {candidate.bitrate ? `${candidate.bitrate} kbps` : '—'}
      </span>
      <span className="w-16 shrink-0 text-zinc-500">{formatBytes(candidate.size)}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-300" title={candidate.filename}>
        {fileBasename(candidate.filename)}
      </span>
      <span className="w-28 shrink-0 truncate text-zinc-500" title={candidate.username}>
        {candidate.username}
      </span>
      <button
        onClick={() => onDownload(candidate)}
        disabled={disabled}
        className="shrink-0 rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1 text-zinc-300 hover:border-amber-600/60 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Download
      </button>
    </div>
  )
}

// ─── Edit form helpers ────────────────────────────────────────────────────────

type EditState = {
  id: number
  artist: string
  title: string
  version: string
  length: string
  album: string
  label: string
}

function toEditState(item: WantListItem): EditState {
  return {
    id: item.id,
    artist: item.artist,
    title: item.title,
    version: item.version ?? '',
    length: item.length ?? '',
    album: item.album ?? '',
    label: item.label ?? ''
  }
}

function toAddInput(state: EditState): WantListAddInput {
  return {
    artist: state.artist,
    title: state.title,
    version: state.version.trim() || null,
    length: state.length.trim() || null,
    album: state.album.trim() || null,
    label: state.label.trim() || null
  }
}

// ─── Item card ────────────────────────────────────────────────────────────────

function WantListCard({
  item,
  onUpdated,
  onRemoved
}: {
  item: WantListItem
  onUpdated: (updated: WantListItem) => void
  onRemoved: (id: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editState, setEditState] = useState<EditState | null>(null)
  const [candidates, setCandidates] = useState<SlskdCandidate[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)

  const hasResults = item.pipelineStatus === 'results_ready' && item.searchResultCount > 0
  const isActive = item.pipelineStatus === 'searching' || item.pipelineStatus === 'downloading'

  // Load candidates when expanding
  useEffect(() => {
    if (!expanded || !hasResults || candidates !== null) return
    setLoadingCandidates(true)
    void window.api.wantList
      .getCandidates(item.id)
      .then((list) => {
        setCandidates(list)
        setLoadingCandidates(false)
      })
  }, [expanded, hasResults, item.id, candidates])

  // Reset loaded candidates when pipeline status changes
  useEffect(() => {
    setCandidates(null)
  }, [item.pipelineStatus])

  const handleSearch = (): void => {
    void window.api.wantList.search(item.id).then((updated) => {
      if (updated) onUpdated(updated)
    })
  }

  const handleDownload = (candidate: SlskdCandidate): void => {
    void window.api.wantList
      .download(item.id, candidate.username, candidate.filename, candidate.size)
      .then(() => setExpanded(false))
  }

  const handleReset = (): void => {
    void window.api.wantList.resetPipeline(item.id).then((updated) => {
      if (updated) onUpdated(updated)
    })
  }

  const startEdit = (): void => {
    setEditState(toEditState(item))
    setEditing(true)
    setExpanded(false)
  }

  const handleSaveEdit = (): void => {
    if (!editState) return
    void window.api.wantList.update(editState.id, toAddInput(editState)).then((updated) => {
      if (updated) onUpdated(updated)
      setEditing(false)
      setEditState(null)
    })
  }

  const inputCls =
    'rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 focus:border-amber-600/60 focus:outline-none'

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30">
      {/* Main row */}
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          {editing && editState ? (
            <div className="grid grid-cols-2 gap-2">
              <input
                value={editState.artist}
                onChange={(e) => setEditState({ ...editState, artist: e.target.value })}
                placeholder="Artist"
                className={inputCls}
              />
              <input
                value={editState.title}
                onChange={(e) => setEditState({ ...editState, title: e.target.value })}
                placeholder="Title"
                className={inputCls}
              />
              <input
                value={editState.version}
                onChange={(e) => setEditState({ ...editState, version: e.target.value })}
                placeholder="Version"
                className={inputCls}
              />
              <input
                value={editState.length}
                onChange={(e) => setEditState({ ...editState, length: e.target.value })}
                placeholder="Length"
                className={inputCls}
              />
              <input
                value={editState.album}
                onChange={(e) => setEditState({ ...editState, album: e.target.value })}
                placeholder="Album"
                className={inputCls}
              />
              <input
                value={editState.label}
                onChange={(e) => setEditState({ ...editState, label: e.target.value })}
                placeholder="Label"
                className={inputCls}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-zinc-100">{item.artist}</span>
                <span className="text-zinc-600">–</span>
                <span className="text-sm text-zinc-200">{item.title}</span>
                {item.version ? (
                  <span className="text-xs text-amber-300/80">{item.version}</span>
                ) : null}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-zinc-500">
                {item.album ? <span>{item.album}</span> : null}
                {item.label ? <span>{item.label}</span> : null}
                {item.length ? <span>{item.length}</span> : null}
              </div>
              {item.pipelineStatus === 'error' && item.pipelineError ? (
                <div className="mt-1 text-xs text-red-400">{item.pipelineError}</div>
              ) : null}
              {(item.pipelineStatus === 'downloading' || item.pipelineStatus === 'downloaded') &&
              item.downloadFilename ? (
                <div
                  className="mt-1 truncate text-xs text-zinc-500"
                  title={item.downloadFilename}
                >
                  {item.pipelineStatus === 'downloading' ? '↓ ' : '✓ '}
                  {fileBasename(item.downloadFilename)}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Status + actions */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <StatusBadge status={item.pipelineStatus} />

          {!editing && (
            <>
              {hasResults ? (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="rounded border border-emerald-800/60 bg-zinc-950/40 px-2 py-0.5 text-xs text-emerald-400 hover:bg-emerald-950/30"
                >
                  {item.searchResultCount} result{item.searchResultCount !== 1 ? 's' : ''}
                  {expanded ? ' ▲' : ' ▼'}
                </button>
              ) : null}

              {(item.pipelineStatus === 'idle' ||
                item.pipelineStatus === 'no_results' ||
                item.pipelineStatus === 'error') && (
                <button
                  onClick={handleSearch}
                  className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-0.5 text-xs text-zinc-400 hover:border-amber-600/60 hover:text-amber-300"
                >
                  Search
                </button>
              )}

              {item.pipelineStatus === 'results_ready' && (
                <button
                  onClick={handleSearch}
                  className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-0.5 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                >
                  Re-search
                </button>
              )}

              {(item.pipelineStatus === 'downloaded' ||
                item.pipelineStatus === 'no_results' ||
                item.pipelineStatus === 'error') && (
                <button
                  onClick={handleReset}
                  title="Reset pipeline"
                  className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-0.5 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                >
                  ↺
                </button>
              )}

              <button
                onClick={startEdit}
                disabled={isActive}
                className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-0.5 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                Edit
              </button>

              <button
                onClick={() => onRemoved(item.id)}
                disabled={isActive}
                className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-0.5 text-xs text-zinc-500 hover:border-red-700/60 hover:text-red-300 disabled:opacity-40"
              >
                ×
              </button>
            </>
          )}

          {editing && (
            <>
              <button
                onClick={handleSaveEdit}
                className="rounded border border-emerald-700/60 bg-zinc-950/40 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-950/30"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditing(false)
                  setEditState(null)
                }}
                className="rounded border border-zinc-700 bg-zinc-950/40 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* Expanded candidates */}
      {expanded && hasResults && (
        <div className="border-t border-zinc-800 px-2 py-2">
          <div className="mb-1 flex items-center gap-3 px-3 text-xs font-medium uppercase tracking-wide text-zinc-600">
            <span className="w-6 text-right">Sc</span>
            <span className="w-12">Fmt</span>
            <span className="w-16">Bitrate</span>
            <span className="w-16">Size</span>
            <span className="flex-1">Filename</span>
            <span className="w-28">User</span>
            <span className="w-16" />
          </div>
          {loadingCandidates ? (
            <div className="px-3 py-2 text-xs text-zinc-500">Loading…</div>
          ) : (
            candidates?.map((c, i) => (
              <CandidateRow
                key={`${c.username}|${c.filename}|${i}`}
                candidate={c}
                onDownload={handleDownload}
                disabled={isActive}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WantlistPage(): React.JSX.Element {
  const [items, setItems] = useState<WantListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setErrorMessage(null)
    void window.api.wantList
      .list()
      .then((result) => setItems(result))
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load want list')
      })
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
    const unsub = window.api.wantList.onItemUpdated((updated) => {
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    })
    unsubRef.current = unsub
    return () => {
      unsub()
      unsubRef.current = null
    }
  }, [load])

  const handleUpdated = useCallback((updated: WantListItem) => {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
  }, [])

  const handleRemoved = useCallback((id: number) => {
    void window.api.wantList.remove(id).then(() => {
      setItems((prev) => prev.filter((item) => item.id !== id))
    })
  }, [])

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300/80">
          Want List
        </div>
        <div className="mt-2 text-2xl font-semibold text-zinc-100">Want List</div>
        <div className="mt-1 text-sm text-zinc-400">
          Tracks you want to find — auto-searched on Soulseek when added
        </div>
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-4 text-sm text-red-200">
          {errorMessage}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
          No tracks yet. Add tracks from a Discogs release page.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <WantListCard
              key={item.id}
              item={item}
              onUpdated={handleUpdated}
              onRemoved={handleRemoved}
            />
          ))}
        </div>
      )}
    </div>
  )
}

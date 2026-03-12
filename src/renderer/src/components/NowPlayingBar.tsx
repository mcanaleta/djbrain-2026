import { PlayIcon, TrackNextIcon, TrackPreviousIcon } from '@radix-ui/react-icons'

export default function NowPlayingBar(): React.JSX.Element {
  return (
    <div className="flex h-16 items-center gap-3 border-t border-zinc-800 bg-zinc-950/60 px-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-100 hover:bg-zinc-900/60"
          aria-label="Previous"
        >
          <TrackPreviousIcon />
        </button>
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-100 hover:bg-zinc-900/60"
          aria-label="Play/Pause"
        >
          <PlayIcon />
        </button>
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-100 hover:bg-zinc-900/60"
          aria-label="Next"
        >
          <TrackNextIcon />
        </button>
      </div>

      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-100">Not playing</div>
        <div className="truncate text-xs text-zinc-400">Wire up playback later (local-first).</div>
      </div>
    </div>
  )
}

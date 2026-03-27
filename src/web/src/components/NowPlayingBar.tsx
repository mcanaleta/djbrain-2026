import { useState } from 'react'
import { PauseIcon, PlayIcon, TrackNextIcon, TrackPreviousIcon } from '@radix-ui/react-icons'
import { usePlayer } from '../context/PlayerContext'

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds === 0) return '—:——'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function NowPlayingBar(): React.JSX.Element {
  const { track, isPlaying, currentTime, duration, toggle, seek } = usePlayer()

  // During drag we track the visual position separately and only call seek() once
  // on pointer-up. Firing seek() on every onChange pixel would send hundreds of
  // currentTime assignments to the audio element, leaving it in a broken state.
  const [isDragging, setIsDragging] = useState(false)
  const [dragValue, setDragValue] = useState(0)

  const sliderValue = isDragging ? dragValue : currentTime
  const displayTime = isDragging ? dragValue : currentTime

  return (
    <div className="flex h-16 items-center gap-4 border-t border-zinc-800 bg-zinc-950/80 px-4">
      {/* Transport controls */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled
          className="inline-flex h-8 w-8 items-center justify-center rounded text-zinc-600 disabled:cursor-not-allowed"
          aria-label="Previous"
        >
          <TrackPreviousIcon className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={toggle}
          disabled={!track}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <PauseIcon className="h-4 w-4" />
          ) : (
            <PlayIcon className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          disabled
          className="inline-flex h-8 w-8 items-center justify-center rounded text-zinc-600 disabled:cursor-not-allowed"
          aria-label="Next"
        >
          <TrackNextIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Track info */}
      <div className="min-w-0 w-48 shrink-0">
        {track ? (
          <>
            <div className="truncate text-sm font-medium text-zinc-100">{track.title}</div>
            <div className="truncate text-xs text-zinc-400">{track.artist}</div>
          </>
        ) : (
          <div className="text-sm text-zinc-500">Not playing</div>
        )}
      </div>

      {/* Progress bar + time */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-zinc-500">
          {formatTime(displayTime)}
        </span>
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 1}
          step={0.5}
          value={sliderValue}
          onChange={(e) => {
            // Visual-only update during drag — do NOT call seek() here
            setDragValue(Number(e.target.value))
            setIsDragging(true)
          }}
          onPointerUp={(e) => {
            // One seek when the user releases — avoids bombarding the audio element
            const val = Number((e.target as HTMLInputElement).value)
            setIsDragging(false)
            seek(val)
          }}
          onKeyUp={(e) => {
            // Arrow-key nudges also commit on key release
            seek(Number((e.target as HTMLInputElement).value))
          }}
          disabled={!track || duration === 0}
          className="min-w-0 flex-1 accent-zinc-400 disabled:opacity-30"
          aria-label="Seek"
        />
        <span className="shrink-0 text-xs tabular-nums text-zinc-500">
          {formatTime(duration)}
        </span>
      </div>
    </div>
  )
}

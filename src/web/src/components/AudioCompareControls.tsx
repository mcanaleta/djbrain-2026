import { Link1Icon, LinkBreak2Icon, PauseIcon, PlayIcon } from '@radix-ui/react-icons'
import { ActionButton } from './view/ActionButton'
import { formatCompactDuration } from '../lib/music-file'

type DeckProps = {
  label: string
  playing: boolean
  disabled?: boolean
  time: number
  duration: number | null
  playLabel: string
  pauseLabel: string
  onToggle: () => void
  onSeek: (time: number) => void
}

export function AudioCompareControls({
  left,
  right,
  linked,
  onToggleLinked,
  crossfade,
  onCrossfade,
  crossfadeDisabled = false,
  className = ''
}: {
  left: DeckProps
  right: DeckProps
  linked: boolean
  onToggleLinked: () => void
  crossfade: number
  onCrossfade: (value: number) => void
  crossfadeDisabled?: boolean
  className?: string
}): React.JSX.Element {
  const renderDeck = (deck: DeckProps): React.JSX.Element => {
    const limit = Math.max(deck.duration ?? 0, 0)
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">{deck.label}</div>
          <div className="text-[10px] text-zinc-500">
            {formatCompactDuration(deck.time)} / {formatCompactDuration(deck.duration)}
          </div>
        </div>
        <ActionButton
          size="xs"
          tone={deck.playing ? 'primary' : 'default'}
          disabled={deck.disabled}
          onClick={deck.onToggle}
          aria-label={deck.playing ? deck.pauseLabel : deck.playLabel}
        >
          {deck.playing ? <PauseIcon /> : <PlayIcon />}
        </ActionButton>
        <input
          type="range"
          min={0}
          max={limit}
          step={0.1}
          value={Math.min(deck.time, limit)}
          onChange={(event) => deck.onSeek(Number(event.target.value))}
          disabled={deck.disabled}
          className="w-full"
        />
      </div>
    )
  }

  return (
    <div className={`grid gap-2 md:grid-cols-[1fr,140px,1fr] ${className}`.trim()}>
      {renderDeck(left)}
      <div className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-zinc-800/70 px-2 py-1">
        <ActionButton
          size="xs"
          tone={linked ? 'primary' : 'default'}
          disabled={crossfadeDisabled}
          onClick={onToggleLinked}
          aria-label={linked ? 'Unlink players' : 'Link players'}
        >
          {linked ? <Link1Icon /> : <LinkBreak2Icon />}
        </ActionButton>
        <div className="flex w-full items-center gap-1 text-[9px] text-zinc-500">
          <span>N</span>
          <input
            type="range"
            min={0}
            max={100}
            value={crossfade}
            onChange={(event) => onCrossfade(Number(event.target.value))}
            disabled={crossfadeDisabled}
            className="w-full"
          />
          <span>E</span>
        </div>
      </div>
      {renderDeck(right)}
    </div>
  )
}

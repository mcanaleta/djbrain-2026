import { Badge } from './Badge'

export function QualityBadge({ quality, title }: { quality: string; title?: string }): React.JSX.Element {
  const score = Number(quality)
  const className = !Number.isFinite(score)
    ? 'bg-zinc-700 text-zinc-100'
    : score >= 85
      ? 'bg-emerald-400 text-emerald-950'
      : score >= 70
        ? 'bg-amber-300 text-amber-950'
        : 'bg-rose-400 text-rose-950'
  return <Badge label={quality} className={className} title={title} />
}

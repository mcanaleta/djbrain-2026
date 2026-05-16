import { Badge } from './Badge'

const LOSSLESS_FORMATS = new Set(['wav', 'flac', 'aiff', 'aif', 'alac'])
const LOSSY_FORMATS = new Set(['mp3', 'aac', 'm4a', 'ogg', 'opus'])

export function FormatBadge({ format }: { format: string }): React.JSX.Element {
  const normalized = format.toLowerCase()
  const className = LOSSLESS_FORMATS.has(normalized)
    ? 'bg-sky-400 text-sky-950'
    : LOSSY_FORMATS.has(normalized)
      ? 'bg-fuchsia-400 text-fuchsia-950'
      : 'bg-zinc-700 text-zinc-100'
  return <Badge label={format} className={className} />
}

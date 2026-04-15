import { ExternalLinkIcon } from '@radix-ui/react-icons'

export function SourceLinks({
  discogsUrl,
  musicBrainzUrl
}: {
  discogsUrl?: string | null
  musicBrainzUrl?: string | null
}): React.JSX.Element | null {
  if (!discogsUrl && !musicBrainzUrl) return null
  return (
    <div className="mt-0.5 flex flex-wrap gap-1 text-[10px]">
      {discogsUrl ? (
        <a
          href={discogsUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1 text-zinc-400 hover:border-amber-700/60 hover:text-amber-200"
        >
          Discogs
          <ExternalLinkIcon className="h-2.5 w-2.5" />
        </a>
      ) : null}
      {musicBrainzUrl ? (
        <a
          href={musicBrainzUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1 text-zinc-400 hover:border-amber-700/60 hover:text-amber-200"
        >
          MB
          <ExternalLinkIcon className="h-2.5 w-2.5" />
        </a>
      ) : null}
    </div>
  )
}

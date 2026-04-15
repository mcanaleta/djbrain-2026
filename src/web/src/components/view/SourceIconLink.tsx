import { ExternalLinkIcon } from '@radix-ui/react-icons'
import { cx } from './cx'

export function SourceIconLink({
  url,
  label,
  className
}: {
  url: string | null | undefined
  label: string
  className?: string
}): React.JSX.Element {
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className={cx(
        'inline-flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-950/50 text-zinc-100 hover:border-amber-700/60 hover:text-amber-200',
        className
      )}
      title={`${label}: ${url}`}
    >
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  ) : (
    <span className={cx('text-zinc-600', className)}>—</span>
  )
}

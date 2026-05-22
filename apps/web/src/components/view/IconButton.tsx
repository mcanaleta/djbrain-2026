import type { ButtonHTMLAttributes } from 'react'
import { cx } from './cx'

export function IconButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-950/50 text-zinc-100 hover:border-amber-700/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  )
}

import type { ReactNode } from 'react'
import { PILL_TONE_CLASS, type PillTone } from './button-shared'
import { cx } from './cx'

export function Pill({
  children,
  tone = 'muted',
  pulse = false,
  className
}: {
  children: ReactNode
  tone?: PillTone
  pulse?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span className={cx('inline-flex items-center rounded border px-1.5 py-0.5 text-[10px]', PILL_TONE_CLASS[tone], className)}>
      {pulse ? <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {children}
    </span>
  )
}

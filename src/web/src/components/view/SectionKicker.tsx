import type { ReactNode } from 'react'
import { cx } from './cx'

export function SectionKicker({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cx('text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500', className)}>{children}</div>
}

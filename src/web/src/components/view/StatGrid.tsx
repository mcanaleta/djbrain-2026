import type { ReactNode } from 'react'
import { cx } from './cx'

export function StatGrid({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cx('grid min-w-[220px] grid-cols-2 gap-1.5 text-xs', className)}>{children}</div>
}

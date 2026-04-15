import type { ReactNode } from 'react'
import { cx } from './cx'
import { Notice } from './Notice'

export function EmptyState({
  message,
  className
}: {
  message: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Notice tone="default" className={cx('text-zinc-500', className)}>
      {message}
    </Notice>
  )
}

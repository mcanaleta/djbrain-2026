import type { ReactNode } from 'react'
import { cx } from './cx'

type NoticeTone = 'default' | 'error' | 'warning' | 'success'

const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
  default: 'border-zinc-800 bg-zinc-950/30 text-zinc-400',
  error: 'border-red-800/70 bg-red-950/30 text-red-200',
  warning: 'border-amber-800/70 bg-amber-950/30 text-amber-200',
  success: 'border-emerald-800/70 bg-emerald-950/30 text-emerald-200'
}

export function Notice({
  children,
  tone = 'default',
  className
}: {
  children: ReactNode
  tone?: NoticeTone
  className?: string
}): React.JSX.Element {
  return <div className={cx('rounded-xl border px-2.5 py-1.5 text-xs', NOTICE_TONE_CLASS[tone], className)}>{children}</div>
}

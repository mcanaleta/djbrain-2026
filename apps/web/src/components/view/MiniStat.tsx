import type { ReactNode } from 'react'
import { cx } from './cx'

export function MiniStat({
  label,
  value,
  title,
  className
}: {
  label: ReactNode
  value: ReactNode
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cx('rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1.5', className)} title={title}>
      <div className="text-[9px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className="mt-0.5 text-xs font-medium text-zinc-100">{value}</div>
    </div>
  )
}

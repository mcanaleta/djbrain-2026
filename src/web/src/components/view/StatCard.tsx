import type { ReactNode } from 'react'
import { ViewPanel } from './ViewPanel'

export function StatCard({
  label,
  value,
  detail,
  className
}: {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <ViewPanel tone="muted" padding="sm" className={className}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] text-zinc-500">{detail}</div> : null}
    </ViewPanel>
  )
}

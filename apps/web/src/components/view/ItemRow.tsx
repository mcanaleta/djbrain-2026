import type { ReactNode } from 'react'
import { ViewPanel } from './ViewPanel'

export function ItemRow({
  title,
  subtitle,
  detail,
  prefix,
  badges,
  actions,
  className
}: {
  title: ReactNode
  subtitle?: ReactNode
  detail?: ReactNode
  prefix?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <ViewPanel tone="muted" padding="sm" className={className}>
      <div className="flex flex-wrap items-start gap-1.5">
        {prefix ? <div className="shrink-0">{prefix}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="min-w-0 flex-1 text-xs font-medium text-zinc-100">{title}</div>
            {badges}
          </div>
          {subtitle ? <div className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</div> : null}
          {detail ? <div className="mt-0.5 text-[11px] text-zinc-400">{detail}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-1.5">{actions}</div> : null}
      </div>
    </ViewPanel>
  )
}

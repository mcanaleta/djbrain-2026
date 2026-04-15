import type { ReactNode } from 'react'
import { cx } from './cx'
import { type PanelPadding, type PanelTone } from './panel-shared'
import { ViewPanel } from './ViewPanel'

export function ViewSection({
  title,
  subtitle,
  aside,
  children,
  tone = 'default',
  padding = 'md',
  borderless = false,
  className,
  bodyClassName
}: {
  title?: ReactNode
  subtitle?: ReactNode
  aside?: ReactNode
  children: ReactNode
  tone?: PanelTone
  padding?: PanelPadding
  borderless?: boolean
  className?: string
  bodyClassName?: string
}): React.JSX.Element {
  const hasHeader = Boolean(title || subtitle || aside)
  return (
    <ViewPanel tone={tone} padding={padding} borderless={borderless} className={className}>
      {hasHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {title ? <div className="text-[13px] font-semibold text-zinc-100">{title}</div> : null}
            {subtitle ? <div className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</div> : null}
          </div>
          {aside}
        </div>
      ) : null}
      <div className={cx(hasHeader && 'mt-2', bodyClassName)}>{children}</div>
    </ViewPanel>
  )
}

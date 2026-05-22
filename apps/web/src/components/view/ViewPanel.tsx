import type { ReactNode } from 'react'
import { cx } from './cx'
import { PANEL_PADDING_CLASS, PANEL_TONE_CLASS, type PanelPadding, type PanelTone } from './panel-shared'

export function ViewPanel({
  children,
  tone = 'default',
  padding = 'md',
  borderless = false,
  className
}: {
  children: ReactNode
  tone?: PanelTone
  padding?: PanelPadding
  borderless?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cx('rounded-xl', !borderless && 'border', PANEL_TONE_CLASS[tone], PANEL_PADDING_CLASS[padding], className)}
    >
      {children}
    </div>
  )
}

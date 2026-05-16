import type { ReactNode } from 'react'
import { ViewSection } from './ViewSection'

export function PageHero({
  eyebrow,
  title,
  subtitle,
  badges,
  meta,
  aside,
  children
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  badges?: ReactNode
  meta?: ReactNode
  aside?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <ViewSection
      tone="hero"
      title={
        <div className="space-y-1.5">
          {eyebrow ? <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{eyebrow}</div> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="min-w-0 text-xl font-semibold tracking-tight text-zinc-100">{title}</div>
            {badges}
          </div>
          {subtitle ? <div className="text-[11px] text-zinc-400">{subtitle}</div> : null}
          {meta ? <div className="flex flex-wrap gap-1 text-[11px] text-zinc-400">{meta}</div> : null}
        </div>
      }
      aside={aside}
      padding="md"
    >
      {children}
    </ViewSection>
  )
}

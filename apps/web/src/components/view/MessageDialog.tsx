import type { ReactNode } from 'react'
import { cx } from './cx'

export function MessageDialog({
  open,
  title,
  children,
  actions,
  onClose,
  className
}: {
  open: boolean
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose?: () => void
  className?: string
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl', className)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold text-zinc-100">{title}</div>
        <div className="mt-2 space-y-2 text-xs text-zinc-400">{children}</div>
        {actions ? <div className="mt-4 flex justify-end gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

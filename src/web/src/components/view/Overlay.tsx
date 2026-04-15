import type { ReactNode } from 'react'
import { ActionButton } from './ActionButton'

export function Overlay({
  title,
  aside,
  onClose,
  children
}: {
  title: string
  aside?: ReactNode
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4">
      <div className="mx-auto w-full max-w-6xl rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="text-[13px] font-semibold text-zinc-100">{title}</div>
          <div className="flex flex-wrap gap-2">
            {aside}
            <ActionButton size="xs" onClick={onClose}>
              Close
            </ActionButton>
          </div>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  )
}

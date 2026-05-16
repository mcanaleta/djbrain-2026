import { ActionButton } from '../../components/view/ActionButton'
import type { ImportActionConfirmation } from './importRecordFiles'

export function ImportActionConfirmDialog({
  confirmation,
  busy,
  onCancel,
  onConfirm
}: {
  confirmation: ImportActionConfirmation | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element | null {
  if (!confirmation) return null
  const danger = confirmation.confirmLabel === 'Replace'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-action-confirm-title"
        className="w-full max-w-xl rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div id="import-action-confirm-title" className="text-sm font-semibold text-zinc-100">
          {confirmation.title}
        </div>
        <ul className="mt-3 space-y-1.5 text-xs text-zinc-300">
          {confirmation.lines.map((line) => (
            <li key={line} className="rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1.5">{line}</li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <ActionButton size="sm" disabled={busy} onClick={onCancel}>Cancel</ActionButton>
          <ActionButton size="sm" tone={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy ? `${confirmation.confirmLabel}...` : confirmation.confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

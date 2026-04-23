import { ActionButton } from '../../components/view/ActionButton'
import { MessageDialog } from '../../components/view/MessageDialog'

export function IdentifyDeleteDialog({
  open,
  filename,
  busyAction,
  onClose,
  onConfirm
}: {
  open: boolean
  filename: string
  busyAction: string | null
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <MessageDialog
      open={open}
      title="Delete File?"
      onClose={onClose}
      actions={
        <>
          <ActionButton size="sm" disabled={busyAction === 'delete-next'} onClick={onClose}>Cancel</ActionButton>
          <ActionButton size="sm" tone="danger" disabled={busyAction === 'delete-next'} onClick={onConfirm}>
            {busyAction === 'delete-next' ? 'Deleting…' : 'Confirm Delete and Go to Next'}
          </ActionButton>
        </>
      }
    >
      <div>Delete this file and move on to the next review item?</div>
      <div className="truncate text-[11px] text-zinc-500">{filename}</div>
    </MessageDialog>
  )
}

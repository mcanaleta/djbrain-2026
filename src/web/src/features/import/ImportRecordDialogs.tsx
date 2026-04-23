import type { CollectionItem, RecordingDetails } from '../../../../shared/api'
import { ActionButton } from '../../components/view/ActionButton'
import { MessageDialog } from '../../components/view/MessageDialog'
import { buildAssignConfirmText } from './importRecordUtils'

export function ImportRecordDialogs({
  recording,
  pendingAssign,
  pendingDelete,
  confirmReplaceOpen,
  replacePair,
  busyAction,
  onCloseAssign,
  onConfirmAssign,
  onCloseDelete,
  onConfirmDelete,
  onCloseReplace,
  onConfirmReplace
}: {
  recording: RecordingDetails
  pendingAssign: CollectionItem | null
  pendingDelete: string | null
  confirmReplaceOpen: boolean
  replacePair: { sourceFilename: string; targetFilename: string } | null
  busyAction: string | null
  onCloseAssign: () => void
  onConfirmAssign: () => void
  onCloseDelete: () => void
  onConfirmDelete: () => void
  onCloseReplace: () => void
  onConfirmReplace: () => void
}): React.JSX.Element {
  return (
    <>
      <MessageDialog
        open={pendingAssign != null}
        title="Confirm Add To Record"
        onClose={onCloseAssign}
        actions={
          <>
            <ActionButton size="xs" onClick={onCloseAssign}>Cancel</ActionButton>
            <ActionButton size="xs" tone="primary" disabled={!pendingAssign || busyAction === `assign-${pendingAssign?.filename}`} onClick={onConfirmAssign}>
              {pendingAssign && busyAction === `assign-${pendingAssign.filename}` ? 'Adding…' : 'Confirm'}
            </ActionButton>
          </>
        }
      >
        {(pendingAssign ? buildAssignConfirmText(pendingAssign, recording) : []).map((line) => <div key={line}>{line}</div>)}
      </MessageDialog>

      <MessageDialog
        open={pendingDelete != null}
        title="Delete Download"
        onClose={onCloseDelete}
        actions={
          <>
            <ActionButton size="xs" onClick={onCloseDelete}>Cancel</ActionButton>
            <ActionButton size="xs" tone="danger" disabled={!pendingDelete || busyAction === `delete-${pendingDelete}`} onClick={onConfirmDelete}>
              {pendingDelete && busyAction === `delete-${pendingDelete}` ? 'Deleting…' : 'Confirm Delete'}
            </ActionButton>
          </>
        }
      >
        {pendingDelete ? <div>Delete "{pendingDelete}"?</div> : null}
      </MessageDialog>

      <MessageDialog
        open={confirmReplaceOpen}
        title="Replace Existing Song"
        onClose={onCloseReplace}
        actions={
          <>
            <ActionButton size="xs" onClick={onCloseReplace}>Cancel</ActionButton>
            <ActionButton size="xs" tone="primary" disabled={!replacePair || busyAction === `replace-${recording.id}`} onClick={onConfirmReplace}>
              {busyAction === `replace-${recording.id}` ? 'Replacing…' : 'Confirm Replace'}
            </ActionButton>
          </>
        }
      >
        {replacePair ? (
          <>
            <div>Replace "{replacePair.targetFilename}" with "{replacePair.sourceFilename}"?</div>
            <div>The song file will be overwritten and the download file removed.</div>
          </>
        ) : null}
      </MessageDialog>
    </>
  )
}

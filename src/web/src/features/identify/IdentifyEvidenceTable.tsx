import { useRef, useState, type RefObject } from 'react'
import type { IdentifyReference } from '../../../../shared/api'
import { api } from '../../api/client'
import { ActionButton } from '../../components/view/ActionButton'
import { Notice } from '../../components/view/Notice'
import { Pill } from '../../components/view/Pill'
import { ViewSection } from '../../components/view/ViewSection'
import { localFileUrl } from '../../context/PlayerContext'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { FileDetailSections } from '../file/FileDetailSections'
import { IdentifyDeleteDialog } from './IdentifyDeleteDialog'
import { IdentifyRecordCandidates } from './IdentifyRecordCandidates'
import { IdentifyReviewFooterActions, IdentifyReviewSearchActions } from './IdentifyReviewActions'
import { parseIdentifySearchHint } from './reviewData'
import { useIdentifyReviewData } from './useIdentifyReviewData'

type IdentifyData = ReturnType<typeof useIdentifyReviewData>
type IdentifyActions = ReturnType<typeof useAsyncAction>

function IdentifyReviewPanel({
  data,
  actions,
  audioRef,
  canIdentify,
  errorMessage,
  confirmDelete,
  onBack,
  onPlayLocal,
  onReidentify,
  onBetterIdentify,
  onSkip,
  onUnverify,
  onVerify,
  onDelete,
  onCloseDelete,
  onConfirmDelete
}: {
  data: IdentifyData
  actions: IdentifyActions
  audioRef: RefObject<HTMLAudioElement | null>
  canIdentify: boolean
  errorMessage: string | null
  confirmDelete: boolean
  onBack: () => void
  onPlayLocal: () => void
  onReidentify: () => void
  onBetterIdentify: () => void
  onSkip: () => void
  onUnverify: () => void
  onVerify: () => void
  onDelete: () => void
  onCloseDelete: () => void
  onConfirmDelete: () => void
}): React.JSX.Element {
  const {
    item,
    isPending,
    searchDraft,
    setSearchDraft,
    selectedCandidateId,
    setSelectedCandidateId,
    reviewData,
    inferredReferences,
    groups
  } = data

  return (
    <ViewSection
      padding="sm"
      title="Identification Review"
      subtitle={isPending ? 'Loading…' : item ? undefined : 'Missing file'}
      aside={
        <ActionButton size="xs" onClick={onBack}>
          Back
        </ActionButton>
      }
    >
      {isPending ? <Notice>Loading identification…</Notice> : null}
      {!isPending && !item ? <Notice tone="warning">Missing file.</Notice> : null}
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      {actions.errorMessage ? <Notice tone="error">{actions.errorMessage}</Notice> : null}
      {actions.actionMessage ? <Notice tone="success">{actions.actionMessage}</Notice> : null}
      {!item ? null : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="font-medium text-zinc-100">{item.filename}</div>
            <Pill tone={item.identification?.verifiedAt ? 'primary' : 'muted'}>
              {item.identification?.verifiedAt
                ? `Verified ${new Date(item.identification.verifiedAt).toLocaleString()}`
                : 'Unverified'}
            </Pill>
          </div>
          <IdentifyReviewSearchActions
            searchDraft={searchDraft}
            canIdentify={canIdentify}
            busyAction={actions.busyAction}
            onSearchDraftChange={setSearchDraft}
            onReidentify={onReidentify}
            onBetterIdentify={onBetterIdentify}
          />
          <div className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-2">
            <audio
              ref={audioRef}
              className="w-full"
              controls
              preload="metadata"
              src={localFileUrl('', item.filename)}
            >
              <track kind="captions" />
            </audio>
          </div>
          {!reviewData?.recordCandidates.length ? (
            <Notice tone="warning">
              No stored review snapshot yet. Reidentify to build record candidates.
            </Notice>
          ) : null}
          {inferredReferences.length || groups.length ? (
            <IdentifyRecordCandidates
              candidates={groups}
              inferredReferences={inferredReferences}
              onPlayLocal={(_reference: IdentifyReference) => onPlayLocal()}
              onPlayExternal={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
              onToggleCandidate={(candidateId) =>
                setSelectedCandidateId((current) => (current === candidateId ? null : candidateId))
              }
            />
          ) : null}
          <IdentifyReviewFooterActions
            verifiedAt={item.identification?.verifiedAt}
            busyAction={actions.busyAction}
            selectedCandidateId={selectedCandidateId}
            onSkip={onSkip}
            onUnverify={onUnverify}
            onVerify={onVerify}
            onDelete={onDelete}
          />
          <IdentifyDeleteDialog
            open={confirmDelete}
            filename={item.filename}
            busyAction={actions.busyAction}
            onClose={onCloseDelete}
            onConfirm={onConfirmDelete}
          />
        </div>
      )}
    </ViewSection>
  )
}

export function IdentifyEvidenceTable({
  itemId,
  scope,
  query,
  filter,
  onBack,
  onOpenItem
}: {
  itemId: number
  scope: 'downloads' | 'collection'
  query: string
  filter: 'all' | 'verified' | 'unverified'
  onBack: () => void
  onOpenItem: (id: number) => void
}): React.JSX.Element {
  const actions = useAsyncAction()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const data = useIdentifyReviewData(itemId, scope, query, filter)
  const { item, error, refetch, searchDraft, selectedCandidateId, nextItemId } = data

  const canIdentify = Boolean(item && item.identificationStatus !== 'processing')
  const errorMessage =
    error instanceof Error ? error.message : error ? 'Failed to load identification.' : null

  const playLocal = (): void => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = 0
    void audio.play()
  }

  const reidentify = (): void => {
    if (!item) return
    void actions.run({
      key: 'reidentify',
      action: async () => {
        await api.collection.identifyNow(item.filename, parseIdentifySearchHint(searchDraft))
        await refetch()
      },
      successMessage: 'Identification completed.',
      errorFallback: 'Failed to identify file'
    })
  }

  const betterIdentify = (): void => {
    if (!item) return
    void actions.run({
      key: 'better-identify',
      action: async () => {
        await api.collection.identifyBetter(item.filename, parseIdentifySearchHint(searchDraft))
        await refetch()
      },
      successMessage: 'Better identification completed.',
      errorFallback: 'Failed to run better identify'
    })
  }

  const goToNext = (): void => {
    if (nextItemId != null) onOpenItem(nextItemId)
    else onBack()
  }

  const assignAndNext = (): void => {
    if (!item || selectedCandidateId == null) return
    void actions.run({
      key: 'assign-next',
      action: async () => {
        await api.collection.reviewIdentification({
          filename: item.filename,
          action: 'accept',
          candidateId: selectedCandidateId
        })
        goToNext()
      },
      successMessage: 'Source assigned.',
      errorFallback: 'Failed to assign source'
    })
  }

  const unverify = (): void => {
    if (!item) return
    void actions.run({
      key: 'unverify',
      action: async () => {
        await api.collection.reviewIdentification({ filename: item.filename, action: 'unverify' })
        await refetch()
      },
      successMessage: 'Verification cleared.',
      errorFallback: 'Failed to clear verification'
    })
  }

  const deleteAndNext = (): void => {
    if (!item) return
    void actions.run({
      key: 'delete-next',
      action: async () => {
        await api.collection.deleteFile(item.filename)
        setConfirmDelete(false)
        goToNext()
      },
      successMessage: 'File deleted.',
      errorFallback: 'Failed to delete file'
    })
  }

  return (
    <div className="space-y-3">
      <IdentifyReviewPanel
        data={data}
        actions={actions}
        audioRef={audioRef}
        canIdentify={canIdentify}
        errorMessage={errorMessage}
        confirmDelete={confirmDelete}
        onBack={onBack}
        onPlayLocal={playLocal}
        onReidentify={reidentify}
        onBetterIdentify={betterIdentify}
        onSkip={goToNext}
        onUnverify={unverify}
        onVerify={assignAndNext}
        onDelete={() => setConfirmDelete(true)}
        onCloseDelete={() => setConfirmDelete(false)}
        onConfirmDelete={deleteAndNext}
      />
      {item ? <FileDetailSections item={item} refetch={refetch} /> : null}
    </div>
  )
}

import { ActionButton } from '../../components/view/ActionButton'

export function IdentifyReviewSearchActions({
  searchDraft,
  canIdentify,
  busyAction,
  onSearchDraftChange,
  onReidentify,
  onBetterIdentify
}: {
  searchDraft: string
  canIdentify: boolean
  busyAction: string | null
  onSearchDraftChange: (value: string) => void
  onReidentify: () => void
  onBetterIdentify: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={searchDraft}
        onChange={(event) => onSearchDraftChange(event.target.value)}
        placeholder="Artist - Title (Version)"
        className="h-8 min-w-[320px] flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100"
      />
      <ActionButton size="sm" tone="primary" disabled={!canIdentify || busyAction === 'reidentify' || !searchDraft.trim()} onClick={onReidentify}>
        {busyAction === 'reidentify' ? 'Identifying…' : 'Reidentify Search'}
      </ActionButton>
      <ActionButton size="sm" disabled={!canIdentify || busyAction === 'better-identify' || !searchDraft.trim()} onClick={onBetterIdentify}>
        {busyAction === 'better-identify' ? 'Searching…' : 'Better Identify'}
      </ActionButton>
    </div>
  )
}

export function IdentifyReviewFooterActions({
  verifiedAt,
  busyAction,
  selectedCandidateId,
  onSkip,
  onUnverify,
  onVerify,
  onDelete
}: {
  verifiedAt: string | null | undefined
  busyAction: string | null
  selectedCandidateId: number | null
  onSkip: () => void
  onUnverify: () => void
  onVerify: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <ActionButton size="sm" onClick={onSkip}>
        Skip and Go to Next
      </ActionButton>
      {verifiedAt ? (
        <ActionButton size="sm" disabled={busyAction === 'unverify'} onClick={onUnverify}>
          {busyAction === 'unverify' ? 'Clearing…' : 'Unverify'}
        </ActionButton>
      ) : null}
      <ActionButton size="sm" tone="primary" disabled={busyAction === 'assign-next' || selectedCandidateId == null} onClick={onVerify}>
        {busyAction === 'assign-next' ? 'Verifying…' : 'Verify Selected and Go to Next'}
      </ActionButton>
      <ActionButton size="sm" tone="danger" disabled={busyAction === 'delete-next'} onClick={onDelete}>
        Delete and Go to Next
      </ActionButton>
    </div>
  )
}

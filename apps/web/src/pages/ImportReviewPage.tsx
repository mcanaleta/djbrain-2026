import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { ImportCommitInput, ImportReview } from '@djbrain/shared/api'
import { api } from '../api/client'
import { ImportReviewDialog } from '../components/ImportReviewDialog'
import { ActionButton } from '../components/view/ActionButton'
import { Notice } from '../components/view/Notice'
import { ImportActionConfirmDialog } from '../features/import/ImportActionConfirmDialog'
import { ImportRecordFilesTable } from '../features/import/ImportRecordFilesTable'
import { DiscogsTrackAssignDialog } from '../features/collection-item/DiscogsTrackAssignDialog'
import {
  buildImportActionConfirmation,
  buildImportCommitInputFromReview,
  importResultTargetFilename,
  type ImportActionConfirmation,
  type ImportRecordDownloadAction,
  type ImportRecordFileRow
} from '../features/import/importRecordFiles'
import { buildImportRows, groupImportRows } from '../features/import/importRows'
import type { TagDraft } from '../lib/importReview'
import { buildImportHref, buildImportRecordReviewHref } from '../lib/urls'

type ActiveImportReview = { filename: string; review: ImportReview; selectedIndex: number | null; tagDraft: TagDraft }
type CommitAction = Extract<ImportRecordDownloadAction, 'import' | 'replace'>
type PendingCommitAction = { action: CommitAction; row: ImportRecordFileRow; input: ImportCommitInput; confirmation: ImportActionConfirmation }

export default function ImportReviewPage(): React.JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const routeParams = useParams()
  const [searchParams] = useSearchParams()
  const recordIdParam = routeParams.recordId ?? searchParams.get('recordId')
  const recordId = Number(recordIdParam)
  const legacyFilename = searchParams.get('filename')
  const query = searchParams.get('query') ?? ''
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [pendingDeleteFilename, setPendingDeleteFilename] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [activeReview, setActiveReview] = useState<ActiveImportReview | null>(null)
  const [pendingCommit, setPendingCommit] = useState<PendingCommitAction | null>(null)
  const [committedTargetFilename, setCommittedTargetFilename] = useState<string | null>(null)
  const [showDiscogsAssign, setShowDiscogsAssign] = useState(false)
  const { data: listResult, isPending } = useQuery({
    queryKey: ['collection', 'downloads', query],
    queryFn: () => api.collection.listDownloads(query)
  })
  const items = listResult?.items ?? []
  const records = useMemo(() => groupImportRows(buildImportRows(items)), [items])
  const record = useMemo(
    () =>
      Number.isFinite(recordId) && recordId > 0
        ? records.find((row) => row.id === recordId || row.legacyIds.includes(recordId)) ?? null
        : recordIdParam
          ? records.find((row) => row.key === recordIdParam) ?? null
        : legacyFilename
          ? records.find((row) => row.files.some((file) => file.filename === legacyFilename)) ?? null
          : null,
    [legacyFilename, recordId, recordIdParam, records]
  )
  const collectionTargetFilename = record?.replacementFilename ?? committedTargetFilename
  const { data: collectionTarget = null } = useQuery({
    queryKey: ['collection', 'item', collectionTargetFilename ?? null],
    queryFn: () => collectionTargetFilename ? api.collection.get(collectionTargetFilename) : Promise.resolve(null),
    enabled: Boolean(collectionTargetFilename)
  })

  useEffect(() => {
    if (!record || routeParams.recordId === String(record.id)) return
    navigate(buildImportRecordReviewHref(record.id, query), { replace: true })
  }, [navigate, query, record, routeParams.recordId])

  useEffect(() => {
    if (!record) return
    const selectedInRecord = selectedFilename && record.files.some((file) => file.filename === selectedFilename)
    const legacyInRecord = legacyFilename && record.files.some((file) => file.filename === legacyFilename)
    if (!selectedInRecord) setSelectedFilename(legacyInRecord ? legacyFilename : record.bestFile.filename)
  }, [legacyFilename, record, selectedFilename])

  useEffect(() => {
    setActionSuccess(null)
    setPendingCommit(null)
    setCommittedTargetFilename(null)
  }, [record?.key])

  const importHref = buildImportHref(query)
  const currentIndex = record ? records.findIndex((row) => row.key === record.key) : -1
  const selectedItem = record?.files.find((file) => file.filename === selectedFilename) ?? record?.bestFile ?? null
  const nextRecord = currentIndex >= 0 ? records[currentIndex + 1] ?? null : null
  const nextHref = nextRecord ? buildImportRecordReviewHref(nextRecord.id, query) : importHref
  const discogsQuery = [record?.artist, record?.title].filter(Boolean).join(' ')

  const handleResolved = (): void => {
    navigate(nextHref, { replace: true })
  }

  const refreshDownloads = async (targetFilename?: string | null): Promise<void> => {
    await api.collection.syncNow()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['collection', 'downloads'] }),
      targetFilename ? queryClient.invalidateQueries({ queryKey: ['collection', 'item', targetFilename] }) : Promise.resolve()
    ])
  }

  const handleFileAction = async (action: ImportRecordDownloadAction, row: ImportRecordFileRow): Promise<void> => {
    if (row.kind !== 'download') return
    setSelectedFilename(row.filename)
    setActionError(null)
    setActionSuccess(null)
    if (action === 'delete' && pendingDeleteFilename !== row.filename) {
      setPendingDeleteFilename(row.filename)
      return
    }
    const key = `${action}:${row.filename}`
    setBusyAction(key)
    try {
      if (action === 'delete') {
        await api.collection.deleteFile(row.filename)
        const remaining = record?.files.filter((file) => file.filename !== row.filename) ?? []
        if (remaining.length === 0) handleResolved()
        else {
          setSelectedFilename(remaining[0]?.filename ?? null)
          await refreshDownloads()
        }
        return
      }
      const active = activeReview?.filename === row.filename ? activeReview : null
      const review = active?.review ?? await api.collection.getImportReview(row.filename)
      const selectedIndex = active?.selectedIndex ?? review.selectedCandidateIndex
      const candidate = review.candidates[selectedIndex ?? 0] ?? review.candidates[0] ?? null
      const input = buildImportCommitInputFromReview(
        review,
        action === 'replace' ? 'replace_existing' : 'import_new',
        collectionTarget?.filename ?? null,
        selectedIndex,
        active?.tagDraft
      )
      if (!input) throw new Error('No Discogs candidate available for this file.')
      if (action === 'replace' && !collectionTarget) throw new Error('No collection target is loaded for replacement.')
      setPendingCommit({
        action,
        row,
        input,
        confirmation: buildImportActionConfirmation(action as CommitAction, row, collectionTarget, input, candidate?.destinationRelativePath ?? null)
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unexpected import action error')
    } finally {
      setBusyAction(null)
      setPendingDeleteFilename(null)
    }
  }

  const confirmPendingCommit = async (): Promise<void> => {
    if (!pendingCommit) return
    const key = `${pendingCommit.action}:${pendingCommit.row.filename}`
    setBusyAction(key)
    setActionError(null)
    setActionSuccess(null)
    try {
      const result = await api.collection.commitImport(pendingCommit.input)
      const targetFilename = importResultTargetFilename(result)
      if (targetFilename) setCommittedTargetFilename(targetFilename)
      setActionSuccess(`${pendingCommit.confirmation.confirmLabel} finished. Refreshing files...`)
      setPendingCommit(null)
      setSelectedFilename(pendingCommit.row.filename)
      await refreshDownloads(targetFilename ?? collectionTarget?.filename ?? null)
      setActionSuccess(`${pendingCommit.confirmation.confirmLabel} finished. Files refreshed.`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unexpected import action error')
      setPendingCommit(null)
    } finally {
      setBusyAction(null)
    }
  }

  if (isPending) {
    return <Notice>Loading import record...</Notice>
  }

  if (!record) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <Notice tone="warning">Import record not found.</Notice>
        <ActionButton size="xs" onClick={() => navigate(importHref)}>Back To Import</ActionButton>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ImportRecordFilesTable
        record={record}
        collectionTarget={collectionTarget}
        selectedFilename={selectedItem?.filename ?? null}
        busyAction={busyAction}
        pendingDeleteFilename={pendingDeleteFilename}
        onAction={(action, row) => { void handleFileAction(action, row) }}
        onCancelDelete={() => setPendingDeleteFilename(null)}
        onSelect={setSelectedFilename}
      />
      <div className="flex justify-end">
        <ActionButton size="xs" tone="primary" disabled={!record.recordingId} onClick={() => setShowDiscogsAssign(true)}>
          Assign Discogs
        </ActionButton>
      </div>
      {actionError ? <Notice tone="error">{actionError}</Notice> : null}
      {actionSuccess ? <Notice tone="success">{actionSuccess}</Notice> : null}
      <ImportReviewDialog
        filename={selectedItem?.filename ?? null}
        queuePosition={currentIndex >= 0 ? currentIndex + 1 : null}
        queueTotal={records.length || null}
        onClose={() => navigate(importHref)}
        onReviewChange={setActiveReview}
      />
      <ImportActionConfirmDialog
        confirmation={pendingCommit?.confirmation ?? null}
        busy={busyAction === `${pendingCommit?.action}:${pendingCommit?.row.filename}`}
        onCancel={() => { if (!busyAction) setPendingCommit(null) }}
        onConfirm={() => { void confirmPendingCommit() }}
      />
      {showDiscogsAssign && record.recordingId ? (
        <DiscogsTrackAssignDialog
          recordingId={record.recordingId}
          initialQuery={discogsQuery}
          onClose={() => setShowDiscogsAssign(false)}
          onAssigned={async () => {
            await queryClient.invalidateQueries({ queryKey: ['collection', 'downloads'] })
            if (collectionTargetFilename) await queryClient.invalidateQueries({ queryKey: ['collection', 'item', collectionTargetFilename] })
            setActionSuccess('Discogs track assigned. Files refreshed.')
          }}
        />
      ) : null}
    </div>
  )
}

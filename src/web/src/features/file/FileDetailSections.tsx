import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CollectionItemDetails, IdentificationCandidate } from '../../../../shared/api'
import { api } from '../../api/client'
import { ActionButton } from '../../components/view/ActionButton'
import { KV } from '../../components/view/KV'
import { Notice } from '../../components/view/Notice'
import { ViewSection } from '../../components/view/ViewSection'
import { usePlayer } from '../../context/PlayerContext'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { deriveTrackSummaryFromFilename, formatFileSize } from '../../lib/music-file'
import { buildRecordingHref } from '../../lib/urls'

type Item = CollectionItemDetails
type AsyncActions = ReturnType<typeof useAsyncAction>
type RunAction = (
  key: string,
  action: () => Promise<void>,
  successMessage: string,
  errorFallback: string
) => void
type ReviewAction = (action: 'accept' | 'reject' | 'create_recording', candidateId?: number) => void

const empty = '—'
const fmtDate = (value: string | number | null | undefined): string => {
  if (value == null) return empty
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}
const canonicalText = (value: Item['recordingCanonical']): string =>
  value?.title || value?.artist
    ? `${value.artist || empty} · ${value.title || empty}${value.version ? ` (${value.version})` : ''}${value.year ? ` · ${value.year}` : ''}`
    : empty

function JsonBlock({ value }: { value: string | null | undefined }): React.JSX.Element {
  if (!value) return <div className="text-zinc-500">{empty}</div>
  return (
    <details className="rounded border border-zinc-800 bg-zinc-950/40">
      <summary className="cursor-pointer px-2 py-1 text-[11px] text-zinc-400">Show JSON</summary>
      <pre className="max-h-64 overflow-auto border-t border-zinc-800 p-2 text-[10px] leading-4 text-zinc-300">
        {value}
      </pre>
    </details>
  )
}

function FileActionsSection({
  item,
  refetch,
  actions,
  run
}: {
  item: Item
  refetch: () => Promise<unknown>
  actions: AsyncActions
  run: RunAction
}): React.JSX.Element {
  const navigate = useNavigate()
  const player = usePlayer()
  const upgradeCase = item.upgradeCase
  const summary = useMemo(() => {
    const fallback = deriveTrackSummaryFromFilename(item.filename)
    return {
      artist: item.recordingCanonical?.artist || fallback.artist,
      title: item.recordingCanonical?.title
        ? `${item.recordingCanonical.title}${item.recordingCanonical.version ? ` (${item.recordingCanonical.version})` : ''}`
        : fallback.title,
      year: item.recordingCanonical?.year || fallback.year
    }
  }, [item])

  return (
    <ViewSection
      title="File Details"
      subtitle={`${summary.artist}${summary.year ? ` · ${summary.year}` : ''}`}
      padding="sm"
      aside={
        <div className="flex flex-wrap gap-2">
          <ActionButton
            size="xs"
            tone="primary"
            onClick={() =>
              player.play({
                url: `/api/media?filename=${encodeURIComponent(item.filename)}`,
                filename: item.filename,
                title: summary.title,
                artist: summary.artist
              })
            }
          >
            Play
          </ActionButton>
          <ActionButton
            size="xs"
            onClick={() =>
              run(
                'finder',
                () => api.collection.showInFinder(item.filename),
                'Opened in Finder.',
                'Failed to open Finder'
              )
            }
          >
            Finder
          </ActionButton>
          <ActionButton
            size="xs"
            onClick={() =>
              run(
                'player',
                () => api.collection.openInPlayer(item.filename),
                'Opened in player.',
                'Failed to open player'
              )
            }
          >
            Open Player
          </ActionButton>
          <ActionButton
            size="xs"
            disabled={actions.busyAction === 'reanalyze'}
            onClick={() =>
              run(
                'reanalyze',
                async () => {
                  await api.collection.reanalyze(item.filename)
                  await refetch()
                },
                'Reanalysis completed.',
                'Failed to reanalyze'
              )
            }
          >
            {actions.busyAction === 'reanalyze' ? 'Reanalyzing…' : 'Reanalyze'}
          </ActionButton>
          <ActionButton
            size="xs"
            disabled={actions.busyAction === 'identify'}
            onClick={() =>
              run(
                'identify',
                async () => {
                  await api.collection.queueIdentificationProcessing([item.filename], true)
                  await refetch()
                },
                'Identification refresh queued.',
                'Failed to queue identification'
              )
            }
          >
            {actions.busyAction === 'identify' ? 'Queuing…' : 'Queue Identify'}
          </ActionButton>
          <ActionButton
            size="xs"
            disabled={actions.busyAction === 'sync'}
            onClick={() =>
              run(
                'sync',
                async () => {
                  await api.collection.syncNow()
                  await refetch()
                },
                'Collection synced.',
                'Failed to sync collection'
              )
            }
          >
            {actions.busyAction === 'sync' ? 'Rescanning…' : 'Rescan'}
          </ActionButton>
          {upgradeCase?.status === 'pending_reanalyze' ? (
            <ActionButton
              size="xs"
              tone="success"
              disabled={actions.busyAction === 'mark-reanalyzed'}
              onClick={() =>
                run(
                  'mark-reanalyzed',
                  async () => {
                    await api.upgrades.markReanalyzed(upgradeCase.id)
                    await refetch()
                  },
                  'Upgrade marked as reanalyzed.',
                  'Failed to mark reanalyzed'
                )
              }
            >
              {actions.busyAction === 'mark-reanalyzed' ? 'Saving…' : 'Mark Reanalyzed'}
            </ActionButton>
          ) : null}
          <ActionButton
            size="xs"
            disabled={actions.busyAction === 'upgrade'}
            onClick={() =>
              run(
                'upgrade',
                async () => {
                  const next = upgradeCase ?? (await api.upgrades.open(item.filename))
                  navigate(`/upgrades/${next.id}`)
                },
                '',
                'Failed to open upgrade'
              )
            }
          >
            {upgradeCase ? 'Open Upgrade' : 'Create Upgrade'}
          </ActionButton>
        </div>
      }
    >
      {actions.errorMessage ? <Notice tone="error">{actions.errorMessage}</Notice> : null}
      {actions.actionMessage ? <Notice tone="success">{actions.actionMessage}</Notice> : null}
      <div className="text-xs text-zinc-500">{item.filename}</div>
    </ViewSection>
  )
}

function CoreSection({ item }: { item: Item }): React.JSX.Element {
  return (
    <ViewSection title="Core" padding="sm">
      <KV
        rows={[
          { label: 'Filename', value: item.filename },
          { label: 'Filesize', value: `${formatFileSize(item.filesize)} (${item.filesize} bytes)` },
          { label: 'Mtime', value: fmtDate(item.mtimeMs) },
          {
            label: 'Type',
            value: item.isDownload ? 'Download/import file' : 'Collection/library file'
          }
        ]}
      />
    </ViewSection>
  )
}

function ImportSection({ item }: { item: Item }): React.JSX.Element {
  return (
    <ViewSection title="Import Cache" padding="sm">
      {item.importReview ? (
        <>
          <KV
            rows={[
              { label: 'Status', value: item.importReview.status },
              { label: 'Review version', value: item.importReview.reviewVersion },
              { label: 'Artist', value: item.importReview.parsedArtist || empty },
              { label: 'Title', value: item.importReview.parsedTitle || empty },
              { label: 'Version', value: item.importReview.parsedVersion || empty },
              { label: 'Year', value: item.importReview.parsedYear || empty },
              { label: 'Processed', value: fmtDate(item.importReview.processedAt) },
              { label: 'Error', value: item.importReview.errorMessage || empty }
            ]}
          />
          <div className="mt-2">
            <JsonBlock value={item.importReview.reviewJson} />
          </div>
        </>
      ) : (
        <div className="text-xs text-zinc-500">No row in `import_review_cache`.</div>
      )}
    </ViewSection>
  )
}

function AudioSection({ item }: { item: Item }): React.JSX.Element {
  return (
    <ViewSection title="Audio Cache" padding="sm">
      {item.fileAudioState ? (
        <>
          <KV
            rows={[
              { label: 'Status', value: item.fileAudioState.status },
              { label: 'Hash version', value: item.fileAudioState.hashVersion },
              { label: 'Audio hash', value: item.fileAudioState.audioHash || empty },
              { label: 'Processed', value: fmtDate(item.fileAudioState.processedAt) },
              { label: 'Error', value: item.fileAudioState.errorMessage || empty },
              {
                label: 'Analysis version',
                value: item.audioAnalysisCache?.analysisVersion ?? empty
              },
              { label: 'Analysis processed', value: fmtDate(item.audioAnalysisCache?.processedAt) },
              { label: 'Analysis error', value: item.audioAnalysisCache?.errorMessage || empty },
              { label: 'Duration (s)', value: item.parsedAudioAnalysis?.durationSeconds ?? empty },
              { label: 'Bitrate (kbps)', value: item.parsedAudioAnalysis?.bitrateKbps ?? empty },
              { label: 'Loudness LUFS', value: item.parsedAudioAnalysis?.integratedLufs ?? empty }
            ]}
          />
          <div className="mt-2">
            <JsonBlock value={item.audioAnalysisCache?.analysisJson} />
          </div>
        </>
      ) : (
        <div className="text-xs text-zinc-500">No row in `file_audio_state`.</div>
      )}
    </ViewSection>
  )
}

function CandidateRow({
  candidate,
  busyAction,
  onReview
}: {
  candidate: IdentificationCandidate
  busyAction: string | null
  onReview: ReviewAction
}): React.JSX.Element {
  const busy = busyAction === `accept-${candidate.id}` || busyAction === `reject-${candidate.id}`
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-zinc-100">
            {candidate.provider} · {candidate.entityType} · score {candidate.score}
          </div>
          <div className="truncate text-zinc-500">{candidate.externalKey}</div>
          <div className="text-zinc-300">{canonicalText(candidate.recordingCanonical)}</div>
          <div className="text-zinc-500">Disposition: {candidate.disposition}</div>
        </div>
        <div className="flex gap-2">
          <ActionButton
            size="xs"
            tone="primary"
            disabled={busy}
            onClick={() => onReview('accept', candidate.id)}
          >
            {busyAction === `accept-${candidate.id}` ? 'Saving…' : 'Accept'}
          </ActionButton>
          <ActionButton size="xs" disabled={busy} onClick={() => onReview('reject', candidate.id)}>
            Reject
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

function IdentificationSection({
  item,
  actions,
  review
}: {
  item: Item
  actions: AsyncActions
  review: ReviewAction
}): React.JSX.Element {
  const identification = item.identification
  return (
    <ViewSection title="Identification" padding="sm">
      {identification ? (
        <>
          <KV
            rows={[
              { label: 'Status', value: identification.status },
              {
                label: 'Recording id',
                value: identification.recordingId ? (
                  <a
                    href={buildRecordingHref(identification.recordingId)}
                    className="text-zinc-300 hover:text-zinc-100"
                  >
                    {identification.recordingId}
                  </a>
                ) : (
                  empty
                )
              },
              { label: 'Method', value: identification.assignmentMethod || empty },
              { label: 'Confidence', value: identification.confidence ?? empty },
              { label: 'Canonical', value: canonicalText(identification.recordingCanonical) },
              {
                label: 'Parsed',
                value: `${identification.parsedArtist || empty} · ${identification.parsedTitle || empty}${identification.parsedVersion ? ` (${identification.parsedVersion})` : ''}`
              },
              {
                label: 'Tags',
                value: `${identification.tagArtist || empty} · ${identification.tagTitle || empty}${identification.tagVersion ? ` (${identification.tagVersion})` : ''}`
              },
              { label: 'Audio hash', value: identification.audioHash || empty },
              { label: 'Processed', value: fmtDate(identification.processedAt) },
              { label: 'Error', value: identification.errorMessage || empty }
            ]}
          />
          <div className="mt-2">
            <JsonBlock value={identification.explanationJson} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton
              size="xs"
              tone="primary"
              disabled={actions.busyAction === 'create-recording'}
              onClick={() => review('create_recording')}
            >
              {actions.busyAction === 'create-recording' ? 'Creating…' : 'Create Recording'}
            </ActionButton>
          </div>
          {identification.candidates.length ? (
            <div className="mt-3 space-y-2">
              {identification.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  busyAction={actions.busyAction}
                  onReview={review}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-xs text-zinc-500">No row in `file_identification_state`.</div>
      )}
    </ViewSection>
  )
}

function UpgradeSection({ item }: { item: Item }): React.JSX.Element {
  return (
    <ViewSection title="Upgrade Case" padding="sm">
      {item.upgradeCase ? (
        <KV
          rows={[
            { label: 'Case id', value: item.upgradeCase.id },
            { label: 'Status', value: item.upgradeCase.status },
            { label: 'Search artist', value: item.upgradeCase.searchArtist },
            { label: 'Search title', value: item.upgradeCase.searchTitle },
            { label: 'Search version', value: item.upgradeCase.searchVersion || empty },
            { label: 'Updated', value: fmtDate(item.upgradeCase.updatedAt) }
          ]}
        />
      ) : (
        <div className="text-xs text-zinc-500">No row in `upgrade_cases`.</div>
      )}
    </ViewSection>
  )
}

export function FileDetailSections({
  item,
  refetch
}: {
  item: Item
  refetch: () => Promise<unknown>
}): React.JSX.Element {
  const actions = useAsyncAction()
  const run: RunAction = (key, action, successMessage, errorFallback) => {
    void actions.run({ key, action, successMessage, errorFallback })
  }
  const review: ReviewAction = (action, candidateId) =>
    run(
      candidateId == null ? 'create-recording' : `${action}-${candidateId}`,
      async () => {
        await api.collection.reviewIdentification({ filename: item.filename, action, candidateId })
        await refetch()
      },
      action === 'reject' ? 'Candidate rejected.' : 'Identification updated.',
      'Failed to update identification'
    )

  return (
    <>
      <FileActionsSection item={item} refetch={refetch} actions={actions} run={run} />
      <CoreSection item={item} />
      <ImportSection item={item} />
      <AudioSection item={item} />
      <IdentificationSection item={item} actions={actions} review={review} />
      <UpgradeSection item={item} />
    </>
  )
}

import { DownloadIcon, LockClosedIcon } from '@radix-ui/react-icons'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { SlskdCandidate } from '../../../shared/api'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { EmptyState } from '../components/view/EmptyState'
import { IconButton } from '../components/view/IconButton'
import { LabeledInput } from '../components/view/LabeledInput'
import { Notice } from '../components/view/Notice'
import { Pill } from '../components/view/Pill'
import { QueryBar } from '../components/view/QueryBar'
import { ViewPanel } from '../components/view/ViewPanel'
import { ViewSection } from '../components/view/ViewSection'
import { localFileUrl, usePlayer } from '../context/PlayerContext'
import {
  deriveTrackSummaryFromFilename,
  fileBasename,
  formatCompactDuration,
  formatFileSize
} from '../lib/music-file'
import {
  getSoulseekActionKey,
  updateWantListEditState,
  type WantListEditState
} from '../features/wantlist/view-model'
import { WantListStatusBadge } from '../features/wantlist/WantListStatusBadge'
import {
  useWantListItemPage,
  type WantListLocalResult,
  type WantListVideoResult
} from '../features/wantlist/useWantListItemPage'

function LocalResultRow({
  item,
  importedFilename,
  busyAction,
  onImport,
  onShowInFinder,
  onOpenInPlayer
}: {
  item: WantListLocalResult
  importedFilename: string | null
  busyAction: string | null
  onImport: (filename: string) => void
  onShowInFinder: (filename: string) => void
  onOpenInPlayer: (filename: string) => void
}): React.JSX.Element {
  const player = usePlayer()
  const summary = deriveTrackSummaryFromFilename(item.filename)
  const isCurrent = player.track?.filename === item.filename

  return (
    <tr className="border-t border-zinc-800 text-[11px] text-zinc-200">
      <td className="px-2 py-1.5 whitespace-nowrap">
        <Pill tone={item.source === 'download' ? 'muted' : 'default'}>
          {item.source === 'download' ? 'Download' : 'Song'}
        </Pill>
      </td>
      <td className="px-2 py-1.5 max-w-[260px] truncate font-medium" title={item.filename}>
        {summary.artist} – {summary.title}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap text-zinc-500">{formatCompactDuration(item.duration)}</td>
      <td className="px-2 py-1.5 whitespace-nowrap text-zinc-500">{formatFileSize(item.filesize)}</td>
      <td className="px-2 py-1.5 w-[1%]">
        <div className="flex items-center gap-1">
          <ActionButton type="button" size="xs" onClick={() => {
            if (isCurrent) { player.toggle(); return }
            player.play({ url: localFileUrl('', item.filename), filename: item.filename, title: summary.title, artist: summary.artist })
          }}>
            {isCurrent && player.isPlaying ? 'Pause' : 'Play'}
          </ActionButton>
          {item.source === 'download' ? (
            <ActionButton type="button" size="xs" tone="success"
              disabled={busyAction === `import:${item.filename}`}
              onClick={() => onImport(item.filename)}>
              {busyAction === `import:${item.filename}` ? 'Importing…' : 'Import'}
            </ActionButton>
          ) : null}
          {importedFilename === item.filename ? (
            <span className="text-[10px] text-emerald-500">Imported</span>
          ) : null}
          <ActionButton type="button" size="xs" onClick={() => onShowInFinder(item.filename)}>Reveal</ActionButton>
          <ActionButton type="button" size="xs" onClick={() => onOpenInPlayer(item.filename)}>Open</ActionButton>
        </div>
      </td>
    </tr>
  )
}

function formatSoulseekSlot(candidate: SlskdCandidate): string {
  if (candidate.hasFreeUploadSlot === true) {
    return 'Open'
  }
  if (candidate.hasFreeUploadSlot === false) {
    return 'Wait'
  }
  return '—'
}

function formatSoulseekUploadSpeed(candidate: SlskdCandidate): string {
  return candidate.uploadSpeed ? formatFileSize(candidate.uploadSpeed) : '—'
}

function soulseekFolderLabel(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : 'root'
}

export default function WantlistItemPage(): React.JSX.Element {
  const { wantId } = useParams<{ wantId: string }>()
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)

  const {
    item,
    editState,
    setEditState,
    soulseekQuery,
    setSoulseekQuery,
    youtubeQuery,
    setYoutubeQuery,
    collectionQuery,
    setCollectionQuery,
    soulseekResults,
    youtubeResults,
    collectionResults,
    isLoading,
    isSaving,
    isLoadingSoulseek,
    isLoadingYouTube,
    isLoadingCollection,
    errorMessage,
    actionError,
    busyAction,
    sectionErrors,
    actions
  } = useWantListItemPage(wantId)

  const activeVideo = youtubeResults.find((video) => video.id === activeVideoId) ?? youtubeResults[0] ?? null
  const metadataFields: Array<{ key: keyof WantListEditState; label: string }> = [
    { key: 'artist', label: 'Artist' },
    { key: 'title', label: 'Title' },
    { key: 'version', label: 'Version' },
    { key: 'length', label: 'Length' },
    { key: 'year', label: 'Year' },
    { key: 'album', label: 'Album' },
    { key: 'label', label: 'Label' }
  ]

  const soulseekColumns = useMemo<DataTableColumn<SlskdCandidate>[]>(
    () => [
      {
        key: 'match',
        header: 'Match',
        cellClassName: 'w-[72px] whitespace-nowrap',
        render: (candidate) => (
          <div className="space-y-0.5 leading-tight">
            <div
              className={
                candidate.score >= 60
                  ? 'text-sm font-semibold text-emerald-300'
                  : candidate.score >= 30
                    ? 'text-sm font-semibold text-amber-300'
                    : 'text-sm font-semibold text-zinc-400'
              }
            >
              {candidate.score}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{candidate.extension}</div>
            {candidate.bitrate ? <div className="text-[10px] text-zinc-500">{candidate.bitrate}</div> : null}
          </div>
        )
      },
      {
        key: 'file',
        header: 'File',
        cellClassName: 'max-w-[1px] min-w-[220px]',
        render: (candidate) => (
          <div className="space-y-1 leading-tight">
            <div className="truncate text-[11px] font-medium text-zinc-100" title={candidate.filename}>
              {fileBasename(candidate.filename)}
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-zinc-500" title={candidate.filename}>
              <span>{formatFileSize(candidate.size)}</span>
              <span>{soulseekFolderLabel(candidate.filename)}</span>
            </div>
          </div>
        )
      },
      {
        key: 'user',
        header: 'User',
        cellClassName: 'min-w-[230px]',
        render: (candidate) => (
          <div className="space-y-1 leading-tight">
            <div className="truncate text-[11px] font-medium text-zinc-200" title={candidate.username}>
              {candidate.username}
            </div>
            <div className="flex flex-wrap gap-1">
              <Pill>Q {typeof candidate.queueLength === 'number' ? candidate.queueLength : '—'}</Pill>
              <Pill tone={candidate.hasFreeUploadSlot === true ? 'success' : 'muted'}>
                {formatSoulseekSlot(candidate)}
              </Pill>
              <Pill tone={candidate.isLocked ? 'danger' : 'muted'}>
                {candidate.isLocked ? 'Locked' : 'Open'}
              </Pill>
              <Pill>Up {formatSoulseekUploadSpeed(candidate)}</Pill>
            </div>
          </div>
        )
      },
      {
        key: 'download',
        header: '',
        cellClassName: 'w-[1%]',
        render: (candidate) => (
          <IconButton
            disabled={busyAction === getSoulseekActionKey(candidate) || candidate.isLocked}
            onClick={() => void actions.download(candidate)}
            title={candidate.isLocked ? 'Locked result' : `Download ${candidate.filename}`}
            aria-label={candidate.isLocked ? 'Locked result' : `Download ${candidate.filename}`}
          >
            {candidate.isLocked ? (
              <LockClosedIcon className="h-2.5 w-2.5" />
            ) : (
              <DownloadIcon className="h-2.5 w-2.5" />
            )}
          </IconButton>
        )
      }
    ],
    [actions, busyAction]
  )

  const youtubeColumns = useMemo<DataTableColumn<WantListVideoResult>[]>(
    () => [
      {
        key: 'video',
        header: 'Video',
        cellClassName: 'max-w-[1px]',
        render: (video) => (
          <div className="space-y-0.5 leading-tight">
            <div className="truncate text-zinc-100" title={video.title}>
              {video.title}
            </div>
            <div className="truncate text-[10px] text-zinc-500" title={video.link}>
              {video.source} · {video.link}
            </div>
          </div>
        )
      },
      {
        key: 'open',
        header: '',
        cellClassName: 'w-[1%]',
        render: (video) => (
          <ActionButton
            type="button"
            size="xs"
            tone={activeVideo?.id === video.id ? 'primary' : 'default'}
            onClick={() => setActiveVideoId(video.id)}
          >
            {activeVideo?.id === video.id ? 'Selected' : 'Open'}
          </ActionButton>
        )
      }
    ],
    [activeVideo?.id]
  )

  if (isLoading) {
    return <Notice>Loading wanted item…</Notice>
  }

  if (errorMessage || !item || !editState) {
    return (
      <div className="space-y-4">
        <Link to="/wantlist" className="text-sm text-zinc-400 hover:text-zinc-100">
          ← Back to Want List
        </Link>
        <Notice tone="error" className="text-sm">
          {errorMessage ?? 'Want list item not found.'}
        </Notice>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Link to="/wantlist" className="text-sm text-zinc-400 hover:text-zinc-100">
          ← Back to Want List
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-zinc-100">
            {item.artist} / {item.title}
          </h1>
          <WantListStatusBadge status={item.pipelineStatus} />
          {item.discogsReleaseId != null ? (
            <Link
              to={`/discogs/${item.discogsEntityType ?? 'release'}/${item.discogsReleaseId}`}
              className="text-xs text-zinc-500 hover:text-zinc-200"
            >
              ↗ Discogs {item.discogsTrackPosition ? `(${item.discogsTrackPosition})` : ''}
            </Link>
          ) : null}
        </div>
      </div>

      {actionError ? <Notice tone="error">{actionError}</Notice> : null}

      <ViewSection
        title="Song"
        subtitle="Edit the wanted item and save."
        aside={
          <ActionButton type="button" tone="success" disabled={isSaving} onClick={() => void actions.save()}>
            {isSaving ? 'Saving…' : 'Save'}
          </ActionButton>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          {metadataFields.map((field) => (
            <LabeledInput
              key={field.key}
              label={field.label}
              value={editState[field.key]}
              onChange={(event) =>
                updateWantListEditState(setEditState, field.key, event.target.value)
              }
            />
          ))}
        </div>
      </ViewSection>

      <ViewSection
        title="Collection Results"
        subtitle="Edit the query and search songs and downloads together."
      >
        <QueryBar
          label="Collection Search"
          value={collectionQuery}
          onChange={setCollectionQuery}
          onSubmit={() => void actions.searchCollection()}
          buttonLabel="Search Again"
          busyLabel="Searching…"
          isBusy={isLoadingCollection}
        />

        {sectionErrors.collection ? <Notice tone="error" className="mt-3">{sectionErrors.collection}</Notice> : null}

        <div className="mt-3">
          {collectionResults.length === 0 ? (
            <EmptyState
              message={isLoadingCollection ? 'Searching collection…' : 'No songs or downloads found.'}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/30">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-zinc-950/50 text-[10px] uppercase tracking-wide text-zinc-500">
                    <th className="px-2 py-1.5 font-medium">Source</th>
                    <th className="px-2 py-1.5 font-medium">File</th>
                    <th className="px-2 py-1.5 font-medium">Dur</th>
                    <th className="px-2 py-1.5 font-medium">Size</th>
                    <th className="px-2 py-1.5 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {collectionResults.map((result) => (
                    <LocalResultRow
                      key={`${result.source}:${result.filename}`}
                      item={result}
                      importedFilename={item.importedFilename}
                      busyAction={busyAction}
                      onImport={(filename) => void actions.importFile(filename)}
                      onShowInFinder={actions.showInFinder}
                      onOpenInPlayer={actions.openInPlayer}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </ViewSection>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <ViewSection title="Soulseek Results" subtitle="Edit the query and run Soulseek search again.">
          <QueryBar
            label="Soulseek Search"
            value={soulseekQuery}
            onChange={setSoulseekQuery}
            onSubmit={() => void actions.searchSoulseek()}
            buttonLabel="Search Again"
            busyLabel="Searching…"
            isBusy={isLoadingSoulseek}
          />

          {sectionErrors.soulseek ? <Notice tone="error" className="mt-3">{sectionErrors.soulseek}</Notice> : null}

          <div className="mt-3">
            <DataTable
              columns={soulseekColumns}
              rows={soulseekResults}
              getRowKey={(candidate, index) => `${candidate.username}:${candidate.filename}:${index}`}
              loading={isLoadingSoulseek}
              loadingMessage="Searching Soulseek…"
              emptyMessage="No Soulseek results yet."
              tableClassName="min-w-[640px]"
              rowClassName="text-[11px]"
            />
          </div>
        </ViewSection>

        <ViewSection title="YouTube Videos" subtitle="Edit the query and refresh the video list.">
          <QueryBar
            label="YouTube Search"
            value={youtubeQuery}
            onChange={setYoutubeQuery}
            onSubmit={() => void actions.searchYouTube()}
            buttonLabel="Search Again"
            busyLabel="Searching…"
            isBusy={isLoadingYouTube}
          />

          {sectionErrors.youtube ? <Notice tone="error" className="mt-3">{sectionErrors.youtube}</Notice> : null}

          <div className="mt-3 space-y-3">
            <DataTable
              columns={youtubeColumns}
              rows={youtubeResults}
              getRowKey={(video) => video.id}
              loading={isLoadingYouTube}
              loadingMessage="Searching YouTube…"
              emptyMessage="No YouTube videos found."
              rowClassName={(video) =>
                video.id === activeVideo?.id ? 'bg-amber-950/20 text-[10px]' : 'text-[10px]'
              }
              onRowClick={(video) => setActiveVideoId(video.id)}
            />

            {activeVideo ? (
              <ViewPanel tone="muted" padding="sm" className="overflow-hidden bg-black p-0">
                <iframe
                  src={`https://www.youtube.com/embed/${activeVideo.id}`}
                  title={activeVideo.title}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  className="aspect-video w-full"
                />
              </ViewPanel>
            ) : null}
          </div>
        </ViewSection>
      </div>
    </div>
  )
}

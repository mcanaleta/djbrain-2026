import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PauseIcon, PlayIcon, TrashIcon } from '@radix-ui/react-icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { FormatBadge } from '../components/view/FormatBadge'
import { LabeledInput } from '../components/view/LabeledInput'
import { Notice } from '../components/view/Notice'
import { Pill } from '../components/view/Pill'
import { QualityBadge } from '../components/view/QualityBadge'
import { SourceIconLink } from '../components/view/SourceIconLink'
import { SourceLinks } from '../components/view/SourceLinks'
import { ViewSection } from '../components/view/ViewSection'
import { usePlayer, localFileUrl } from '../context/PlayerContext'
import type { CollectionItem, CollectionSyncStatus } from '../../../shared/api'
import {
  deriveTrackSummaryFromFilename,
  fileBasename,
  formatCompactDuration,
  formatExtensionName,
  formatFileSize,
  formatQualityScore,
  joinPath
} from '../lib/music-file'
import { getErrorMessage } from '../lib/error-utils'
import { buildImportReviewHref } from '../lib/urls'

const EMPTY_STATUS: CollectionSyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  itemCount: 0,
  lastError: null,
  automationEnabled: false,
  importPendingCount: 0,
  importProcessingCount: 0,
  importErrorCount: 0,
  queueBackend: 'memory',
  queueDepth: 0,
  audioHashVersion: 1,
  audioAnalysisVersion: 1,
  importReviewVersion: 1
}

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected import list error')
}

type ImportRow = CollectionItem & {
  artist: string
  title: string
  year: string
  format: string
  quality: string
  qualityTitle: string
  existingQuality: string
  existingQualityTitle: string
  absolutePath: string
  prep: string
}

type ImportTrackRow = {
  key: string
  artist: string
  title: string
  year: string
  releaseTitle: string | null
  replacementFilename: string | null
  betterQualityFound: boolean | null
  fileCount: number
  prep: string
  bestFile: ImportRow
}


function compareImportRows(left: ImportRow, right: ImportRow): number {
  const leftBetter = left.importBetterThanExisting === true ? 1 : 0
  const rightBetter = right.importBetterThanExisting === true ? 1 : 0
  if (leftBetter !== rightBetter) return rightBetter - leftBetter
  if ((left.importQualityScore ?? -1) !== (right.importQualityScore ?? -1)) {
    return (right.importQualityScore ?? -1) - (left.importQualityScore ?? -1)
  }
  if (left.filesize !== right.filesize) return right.filesize - left.filesize
  return left.filename.localeCompare(right.filename)
}

function summarizePrep(rows: ImportRow[]): string {
  const counts = rows.reduce(
    (result, row) => {
      result[row.prep] = (result[row.prep] ?? 0) + 1
      return result
    },
    {} as Record<string, number>
  )
  return ['error', 'processing', 'ready', 'pending']
    .filter((key) => counts[key])
    .map((key) => `${key} ${counts[key]}`)
    .join(' · ')
}

function normalizeGroupText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeGroupTitle(value: string): string {
  return normalizeGroupText(value)
    .replace(/^[a-z]\d+\s+-\s+/i, '')
    .replace(/\s+\d{6,}$/, '')
}

export default function ImportPage(): React.JSX.Element {
  const player = usePlayer()
  const navigate = useNavigate()
  const [routeSearchParams] = useSearchParams()
  const initialQuery = routeSearchParams.get('query') ?? ''
  const [musicFolderPath, setMusicFolderPath] = useState<string>('')
  const [downloadFolderPaths, setDownloadFolderPaths] = useState<string[]>([])

  const [query, setQuery] = useState(initialQuery)
  const [groupByTrack, setGroupByTrack] = useState(false)
  const [submittedSearch, setSubmittedSearch] = useState({ query: initialQuery, submittedAt: 0 })
  const [items, setItems] = useState<CollectionItem[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<CollectionSyncStatus>(EMPTY_STATUS)
  const [isClearingFolders, setIsClearingFolders] = useState(false)
  const [clearFoldersResult, setClearFoldersResult] = useState<string | null>(null)
  const [queueMessage, setQueueMessage] = useState<string | null>(null)
  const [queueLoading, setQueueLoading] = useState<'process' | 'refresh' | null>(null)

  const latestQueryRef = useRef(submittedSearch.query)
  const requestIdRef = useRef(0)
  const autoQueuedRef = useRef<Set<string>>(new Set())
  latestQueryRef.current = submittedSearch.query

  useEffect(() => {
    api.settings.get().then((settings) => {
      setMusicFolderPath(settings.musicFolderPath)
      setDownloadFolderPaths(settings.downloadFolderPaths)
    }).catch(() => {})
  }, [])

  const loadItems = useCallback(async (searchQuery: string, silent: boolean = false): Promise<void> => {
    const requestId = ++requestIdRef.current
    if (!silent) setIsLoading(true)
    try {
      const result = await api.collection.listDownloads(searchQuery)
      if (requestIdRef.current !== requestId) return
      setItems(result.items)
      setTotal(result.total)
      setErrorMessage(null)
    } catch (error) {
      if (requestIdRef.current !== requestId) return
      setErrorMessage(formatError(error))
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    api.collection.getStatus().then((s) => { if (active) setStatus(s) }).catch(() => {})
    const unsub = api.collection.onUpdated((s) => {
      if (!active) return
      setStatus(s)
      void loadItems(latestQueryRef.current, true)
    })
    return () => { active = false; unsub() }
  }, [loadItems])

  useEffect(() => {
    void loadItems(submittedSearch.query)
  }, [loadItems, submittedSearch.query, submittedSearch.submittedAt])

  const handleSyncNow = async (): Promise<void> => {
    try {
      setStatus(await api.collection.syncNow())
      await loadItems(latestQueryRef.current)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const handlePlay = (item: ImportRow): void => {
    if (!musicFolderPath) return
    player.play({
      url: localFileUrl(musicFolderPath, item.filename),
      filename: item.filename,
      title: item.title,
      artist: item.artist
    })
  }

  const handleDeleteFile = async (filename: string): Promise<void> => {
    try {
      await api.collection.deleteFile(filename)
      // Optimistically remove from local list; sync will confirm
      setItems((prev) => prev.filter((i) => i.filename !== filename))
      setTotal((prev) => prev - 1)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  const handleClearEmptyFolders = async (): Promise<void> => {
    setIsClearingFolders(true)
    setClearFoldersResult(null)
    try {
      const count = await api.collection.clearEmptyFolders()
      setClearFoldersResult(count === 0 ? 'No empty folders found.' : `Removed ${count} empty folder${count === 1 ? '' : 's'}.`)
    } catch (error) {
      setClearFoldersResult(`Error: ${formatError(error)}`)
    } finally {
      setIsClearingFolders(false)
    }
  }

  const rows = useMemo(
    () =>
      items.map((item) => {
        const fallback = deriveTrackSummaryFromFilename(item.filename)
        const canonical = item.recordingCanonical
        const quality = formatQualityScore(item.qualityScore, item.bitrateKbps)
        return {
          ...item,
          artist: canonical?.artist || item.importArtist || fallback.artist,
          title: canonical?.title
            ? `${canonical.title}${canonical.version ? ` (${canonical.version})` : ''}`
            : item.importTitle
              ? `${item.importTitle}${item.importVersion ? ` (${item.importVersion})` : ''}`
              : fallback.title,
          year: canonical?.year || item.importYear || fallback.year,
          format: formatExtensionName(item.filename),
          quality: quality.label,
          qualityTitle: quality.title,
          existingQuality:
            item.importExistingQualityScore == null ? '—' : String(Math.round(item.importExistingQualityScore)),
          existingQualityTitle:
            item.importExistingQualityScore == null
              ? item.importExactExistingFilename
                ? `Existing match: ${item.importExactExistingFilename}`
                : 'No matched existing file'
              : `Existing file analysis score ${Math.round(item.importExistingQualityScore)}/100${item.importExactExistingFilename ? ` · ${item.importExactExistingFilename}` : ''}`,
          absolutePath: joinPath(musicFolderPath, item.filename),
          prep: item.importStatus ?? 'pending'
        }
      }),
    [items, musicFolderPath]
  )

  const groupedRows = useMemo(() => {
    const groups = new Map<string, ImportRow[]>()
    for (const row of rows) {
      const key =
        (row.recordingId != null ? `recording:${row.recordingId}` : null) ||
        row.importTrackKey ||
        `parsed:${normalizeGroupText(row.artist)}:${normalizeGroupTitle(row.title)}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }
    return [...groups.entries()]
      .map(([key, group]) => {
        const bestFile = [...group].sort(compareImportRows)[0]
        return {
          key,
          artist: bestFile.importMatchArtist || bestFile.artist,
          title: bestFile.importMatchTitle
            ? `${bestFile.importMatchTitle}${bestFile.importMatchVersion ? ` (${bestFile.importMatchVersion})` : ''}`
            : bestFile.title,
          year: bestFile.importMatchYear || bestFile.year,
          releaseTitle: bestFile.importReleaseTitle ?? null,
          replacementFilename:
            group.find((row) => row.importExactExistingFilename)?.importExactExistingFilename ?? null,
          betterQualityFound: group.some((row) => row.importBetterThanExisting === true)
            ? true
            : group.some((row) => row.importBetterThanExisting === false)
              ? false
              : null,
          fileCount: group.length,
          prep: summarizePrep(group),
          bestFile
        }
      })
      .sort((left, right) => compareImportRows(left.bestFile, right.bestFile))
  }, [rows])

  useEffect(() => {
    if (!groupByTrack || status.automationEnabled !== true) return
    const identifyFilenames = rows
      .filter((row) => (row.identificationStatus == null || row.identificationStatus === 'pending' || row.identificationStatus === 'error') && !autoQueuedRef.current.has(`identify:${row.filename}`))
      .map((row) => row.filename)
    if (identifyFilenames.length > 0) {
      identifyFilenames.forEach((filename) => autoQueuedRef.current.add(`identify:${filename}`))
      api.collection.queueIdentificationProcessing(identifyFilenames).catch(() => {
        identifyFilenames.forEach((filename) => autoQueuedRef.current.delete(`identify:${filename}`))
      })
    }
    const filenames = rows
      .filter((row) => row.prep === 'pending' && !autoQueuedRef.current.has(`import:${row.filename}`))
      .map((row) => row.filename)
    if (filenames.length === 0) return
    filenames.forEach((filename) => autoQueuedRef.current.add(`import:${filename}`))
    api.collection.queueImportProcessing(filenames).then((result) => {
      if (result.queued > 0) {
        setQueueMessage(`Preparing ${result.queued} file${result.queued === 1 ? '' : 's'} for grouped track review.`)
      }
    }).catch(() => {
      for (const filename of filenames) autoQueuedRef.current.delete(`import:${filename}`)
    })
  }, [groupByTrack, rows, status.automationEnabled])

  const stop = (event: React.SyntheticEvent): void => {
    event.stopPropagation()
  }

  const reviewHref = useCallback(
    (nextFilename: string): string => buildImportReviewHref(nextFilename, submittedSearch.query),
    [submittedSearch.query]
  )

  const handleQueueProcessing = async (force: boolean): Promise<void> => {
    if (rows.length === 0) return
    setQueueLoading(force ? 'refresh' : 'process')
    try {
      const result = await api.collection.queueImportProcessing(rows.map((row) => row.filename), force)
      setQueueMessage(
        result.queued === 0
          ? force
            ? 'Nothing queued for refresh.'
            : 'Nothing pending to process.'
          : `${force ? 'Refreshing' : 'Processing'} ${result.queued} file${result.queued === 1 ? '' : 's'} in background.`
      )
      await loadItems(latestQueryRef.current)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setQueueLoading(null)
    }
  }

  const columns: DataTableColumn<ImportRow>[] = [
    {
      key: 'artist',
      header: 'Artist',
      cellClassName: 'max-w-[180px] truncate text-zinc-200',
      render: (row) => row.artist
    },
    {
      key: 'title',
      header: 'Title',
      cellClassName: 'max-w-[280px] truncate',
      render: (row) => row.title
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-300',
      render: (row) => row.year
    },
    {
      key: 'length',
      header: 'Length',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => formatCompactDuration(row.duration)
    },
    {
      key: 'size',
      header: 'Size',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => formatFileSize(row.filesize)
    },
    {
      key: 'format',
      header: 'Format',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <FormatBadge format={row.format} />
    },
    {
      key: 'quality',
      header: 'Quality',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <QualityBadge quality={row.quality} title={row.qualityTitle} />
    },
    {
      key: 'existing',
      header: 'Existing',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <QualityBadge quality={row.existingQuality} title={row.existingQualityTitle} />
    },
    {
      key: 'discogs',
      header: 'Discogs',
      cellClassName: 'w-[1%] whitespace-nowrap text-center',
      render: (row) => <SourceIconLink url={row.recordingDiscogsUrl} label="Discogs" />
    },
    {
      key: 'musicbrainz',
      header: 'MB',
      cellClassName: 'w-[1%] whitespace-nowrap text-center',
      render: (row) => <SourceIconLink url={row.recordingMusicBrainzUrl} label="MusicBrainz" />
    },
    {
      key: 'delete',
      header: 'Delete',
      cellClassName: 'w-[1%]',
      render: (row) => (
        <ActionButton
          size="xs"
          tone="danger"
          onClick={(event) => {
            stop(event)
            void handleDeleteFile(row.filename)
          }}
        >
          <TrashIcon className="h-3 w-3" />
        </ActionButton>
      )
    },
    {
      key: 'import',
      header: 'Import',
      cellClassName: 'w-[1%]',
      render: (row) => (
        <ActionButton
          size="xs"
          tone="primary"
          onClick={(event) => {
            stop(event)
            navigate(reviewHref(row.filename))
          }}
        >
          Import
        </ActionButton>
      )
    }
  ]

  const groupedColumns: DataTableColumn<ImportTrackRow>[] = [
    {
      key: 'play',
      header: '',
      cellClassName: 'w-[1%]',
      render: (row) => {
        const isCurrentTrack = player.track?.filename === row.bestFile.filename
        return (
          <button
            type="button"
            onClick={(event) => {
              stop(event)
              handlePlay(row.bestFile)
            }}
            disabled={!musicFolderPath}
            title={isCurrentTrack && player.isPlaying ? 'Pause' : 'Play'}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:opacity-30 ${
              isCurrentTrack
                ? 'border-zinc-500 bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
            }`}
          >
            {isCurrentTrack && player.isPlaying ? <PauseIcon className="h-3 w-3" /> : <PlayIcon className="h-3 w-3" />}
          </button>
        )
      }
    },
    {
      key: 'track',
      header: 'Track',
      cellClassName: 'max-w-[360px] truncate text-zinc-100',
      render: (row) => (
        <div>
          <div title={`${row.artist} - ${row.title}`}>{row.artist} - {row.title}</div>
          <div className="truncate text-zinc-500" title={row.releaseTitle ?? row.bestFile.filename}>
            {row.releaseTitle ?? fileBasename(row.bestFile.filename)}
          </div>
          <SourceLinks discogsUrl={row.bestFile.recordingDiscogsUrl} musicBrainzUrl={row.bestFile.recordingMusicBrainzUrl} />
        </div>
      )
    },
    {
      key: 'year',
      header: 'Year',
      cellClassName: 'text-zinc-400',
      render: (row) => row.year
    },
    {
      key: 'files',
      header: 'Files',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) => row.fileCount
    },
    {
      key: 'replace',
      header: 'Replace',
      cellClassName: 'max-w-[260px] truncate text-zinc-300',
      render: (row) =>
        row.replacementFilename ? (
          <div>
            <Pill tone="primary">replace</Pill>
            <div className="mt-1 truncate text-zinc-500" title={row.replacementFilename}>
              {row.replacementFilename}
            </div>
          </div>
        ) : (
          '—'
        )
    },
    {
      key: 'better',
      header: 'Better',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) =>
        row.betterQualityFound === true ? (
          <Pill tone="success">better found</Pill>
        ) : row.betterQualityFound === false ? (
          <Pill>no</Pill>
        ) : (
          '—'
        )
    },
    {
      key: 'best',
      header: 'Best File',
      cellClassName: 'max-w-[240px] truncate text-zinc-300',
      render: (row) => <span title={row.bestFile.filename}>{fileBasename(row.bestFile.filename)}</span>
    },
    {
      key: 'prep',
      header: 'Prep',
      cellClassName: 'whitespace-nowrap text-zinc-400',
      render: (row) => row.prep
    }
  ]

  return (
    <div className="space-y-4">
      <ViewSection
        title="Downloads"
        subtitle="Files in download folders ready to preview and import."
        aside={
          <div className="flex items-center gap-2">
            <ActionButton
              type="button"
              disabled={isClearingFolders}
              onClick={() => {
                void handleClearEmptyFolders()
              }}
            >
              {isClearingFolders ? 'Clearing…' : 'Clear empty folders'}
            </ActionButton>
            <ActionButton
              type="button"
              disabled={status.isSyncing}
              onClick={() => {
                void handleSyncNow()
              }}
            >
              {status.isSyncing ? 'Syncing…' : 'Sync Now'}
            </ActionButton>
          </div>
        }
      >
        {clearFoldersResult ? <div className="mb-3 text-xs text-zinc-400">{clearFoldersResult}</div> : null}
        <div className="flex items-end gap-3">
          <LabeledInput
            label="Search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              setSubmittedSearch({ query: query.trim(), submittedAt: Date.now() })
            }}
            placeholder="Search download items…"
            className="flex-1"
            inputClassName="h-9 rounded-md border-zinc-800 bg-zinc-950/30"
          />
          <div className="shrink-0 pb-1 text-xs text-zinc-400">
            {total} items{groupByTrack ? ` · ${groupedRows.length} tracks` : ''}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionButton size="xs" tone={submittedSearch.query ? 'default' : 'primary'} onClick={() => {
            setQuery('')
            setSubmittedSearch({ query: '', submittedAt: Date.now() })
          }}>
            All
          </ActionButton>
          <ActionButton size="xs" disabled={status.automationEnabled !== true || rows.length === 0 || queueLoading !== null} onClick={() => { void handleQueueProcessing(false) }}>
            {queueLoading === 'process' ? 'Processing…' : 'Process Visible'}
          </ActionButton>
          <ActionButton size="xs" disabled={status.automationEnabled !== true || rows.length === 0 || queueLoading !== null} onClick={() => { void handleQueueProcessing(true) }}>
            {queueLoading === 'refresh' ? 'Refreshing…' : 'Refresh Visible'}
          </ActionButton>
          <ActionButton size="xs" tone={groupByTrack ? 'primary' : 'default'} onClick={() => setGroupByTrack((value) => !value)}>
            {groupByTrack ? 'Grouped By Track' : 'Group By Track'}
          </ActionButton>
          {downloadFolderPaths.map((folder) => (
            <ActionButton key={folder} size="xs" tone={submittedSearch.query === folder ? 'primary' : 'default'} onClick={() => {
              setQuery(folder)
              setSubmittedSearch({ query: folder, submittedAt: Date.now() })
            }}>
              {folder}
            </ActionButton>
          ))}
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          Automation {status.automationEnabled === true ? 'on' : 'off'} · queue {status.queueBackend} · depth {status.queueDepth ?? 0} · waiting {status.importPendingCount ?? 0} · running {status.importProcessingCount ?? 0} · errors {status.importErrorCount ?? 0}
        </div>
      </ViewSection>

      <ViewSection
        title={groupByTrack ? 'Download Tracks' : 'Download Files'}
        subtitle={
          groupByTrack
            ? status.automationEnabled === true
              ? 'Grouped by resolved track identity so duplicates collapse into one review row. Pending files warm in background.'
              : 'Grouped by current identity data only. Background prep is disabled.'
            : 'Compact import queue from configured download roots.'
        }
        borderless
        className="p-0"
        bodyClassName="mt-0"
      >
        {groupByTrack ? (
          <DataTable
            columns={groupedColumns}
            rows={groupedRows}
            getRowKey={(row) => row.key}
            loading={isLoading}
            loadingMessage="Loading…"
            emptyMessage="No tracks in configured download folders. Update env and sync."
            onRowClick={(row) => navigate(reviewHref(row.bestFile.filename))}
            tableClassName="min-w-[1120px]"
            rowClassName={(row) =>
              player.track?.filename === row.bestFile.filename ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/20'
            }
            borderless
            className="rounded-none bg-transparent"
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.filename}
            getRowTitle={(row) => row.absolutePath}
            loading={isLoading}
            loadingMessage="Loading…"
            emptyMessage="No files in configured download folders. Update env and sync."
            onRowClick={(row) => navigate(reviewHref(row.filename))}
            tableClassName="min-w-[1280px]"
            rowClassName={(row) =>
              player.track?.filename === row.filename ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/20'
            }
            borderless
            className="rounded-none bg-transparent"
          />
        )}
      </ViewSection>

      {queueMessage ? <Notice>{queueMessage}</Notice> : null}
      {errorMessage || status.lastError ? (
        <Notice tone="error" className="text-sm">
          {errorMessage ?? status.lastError}
        </Notice>
      ) : null}
    </div>
  )
}

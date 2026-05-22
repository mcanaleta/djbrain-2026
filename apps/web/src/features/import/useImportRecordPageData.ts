import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { getErrorMessage } from '../../lib/error-utils'
import type { DiscogsTrackMatch } from '@djbrain/shared/discogs-match'
import { buildImportRecordSearchQuery, scoreImportRecordLocalMatch } from './importSimilarity'
import { useImportRecordActions } from './useImportRecordActions'
import { useImportRecordSelection } from './useImportRecordSelection'

function formatError(error: unknown, fallback: string): string {
  return getErrorMessage(error, fallback)
}

function isMp3Filename(filename: string | null | undefined): boolean {
  return /\.mp3$/i.test(filename ?? '')
}

function buildImportMatch(recording: NonNullable<Awaited<ReturnType<typeof api.collection.getRecording>>>): DiscogsTrackMatch | null {
  const claim = [...recording.sourceClaims]
    .sort((left, right) =>
      ((right.provider === 'discogs' ? 1000 : right.provider === 'musicbrainz' ? 500 : 0) + right.confidence) -
      ((left.provider === 'discogs' ? 1000 : left.provider === 'musicbrainz' ? 500 : 0) + left.confidence)
    )[0]
  if (!claim) return null
  const raw = claim.rawJson ? JSON.parse(claim.rawJson) as { label?: unknown; catalogNumber?: unknown; format?: unknown } : null
  const releaseId = claim.provider === 'discogs' ? Number(claim.externalKey.match(/^discogs:release:(\d+)/i)?.[1] ?? 0) : 0
  return {
    releaseId: Number.isFinite(releaseId) ? releaseId : 0,
    releaseTitle: claim.releaseTitle ?? recording.canonical.title ?? 'Unknown release',
    format: typeof raw?.format === 'string' ? raw.format : null,
    artist: claim.artist ?? recording.canonical.artist ?? '',
    title: claim.title ?? recording.canonical.title ?? '',
    version: claim.version ?? recording.canonical.version,
    trackPosition: claim.trackPosition,
    year: claim.year ?? recording.canonical.year,
    label: typeof raw?.label === 'string' ? raw.label : null,
    catalogNumber: typeof raw?.catalogNumber === 'string' ? raw.catalogNumber : null,
    score: claim.confidence
  }
}

export function useImportRecordPageData(recordingId: number, submittedQuery: string) {
  const recordingQuery = useQuery({
    queryKey: ['collection', 'recording', recordingId],
    queryFn: () => api.collection.getRecording(recordingId),
    enabled: Number.isInteger(recordingId) && recordingId > 0
  })
  const recording = recordingQuery.data ?? null
  const reviewQuery = useQuery({
    queryKey: ['collection', 'import-record-search', recordingId, buildImportRecordSearchQuery(recording ?? null)],
    queryFn: () => api.collection.list(buildImportRecordSearchQuery(recording ?? null), 120),
    enabled: Boolean(recording)
  })
  const downloadsQuery = useQuery({
    queryKey: ['collection', 'downloads', submittedQuery],
    queryFn: () => api.collection.listDownloads(submittedQuery)
  })
  const similarItems = useMemo(() => {
    if (!recording) return []
    const filenames = new Set(recording.files.map((file) => file.filename))
    return (reviewQuery.data?.items ?? [])
      .filter((item) => !filenames.has(item.filename))
      .map((item) => ({ item, score: scoreImportRecordLocalMatch(item, recording) }))
      .filter(({ score }) => score >= 120)
      .sort((left, right) => right.score - left.score)
      .map(({ item }) => item)
      .slice(0, 12)
  }, [recording, reviewQuery.data?.items])
  const replacePair = useMemo(() => {
    if (!recording) return null
    const downloads = recording.files.filter((file) => file.isDownload)
    const songs = recording.files.filter((file) => !file.isDownload)
    return downloads.length === 1 && songs.length === 1 && isMp3Filename(downloads[0].filename)
      ? { sourceFilename: downloads[0].filename, targetFilename: songs[0].filename }
      : null
  }, [recording])
  const upgradeTargetFilename = useMemo(() => {
    if (!recording) return null
    const songs = recording.files.filter((file) => !file.isDownload)
    return songs.length === 1 ? songs[0].filename : null
  }, [recording])
  const importSourceFilename = useMemo(() => {
    if (!recording) return null
    const downloads = recording.files.filter((file) => file.isDownload)
    return recording.files.length === 1 && downloads.length === 1 && isMp3Filename(downloads[0].filename) ? downloads[0].filename : null
  }, [recording])
  const needsMp3Conversion = useMemo(() => {
    if (!recording) return false
    const downloads = recording.files.filter((file) => file.isDownload)
    const songs = recording.files.filter((file) => !file.isDownload)
    return downloads.length === 1 && !isMp3Filename(downloads[0].filename) && (recording.files.length === 1 || songs.length === 1)
  }, [recording])
  const importMatch = useMemo(() => (recording ? buildImportMatch(recording) : null), [recording])
  const selection = useImportRecordSelection(recording, recordingId, downloadsQuery.data?.items)
  const actions = useImportRecordActions({ recording, replacePair, importSourceFilename, importMatch, upgradeTargetFilename })

  return {
    recording,
    similarItems,
    replacePair,
    upgradeTargetFilename,
    importSourceFilename: importSourceFilename && importMatch ? importSourceFilename : null,
    needsMp3Conversion,
    queuePosition: selection.queuePosition,
    queueTotal: selection.queueTotal,
    nextRecordingId: selection.nextRecordingId,
    compareLeftFilename: selection.compareLeftFilename,
    setCompareLeftFilename: selection.setCompareLeftFilename,
    compareRightFilename: selection.compareRightFilename,
    setCompareRightFilename: selection.setCompareRightFilename,
    isPending: recordingQuery.isPending || reviewQuery.isPending || downloadsQuery.isPending,
    busyAction: actions.busyAction,
    actionMessage: actions.actionMessage,
    errorMessage:
      actions.errorMessage ||
      (recordingQuery.error && formatError(recordingQuery.error, 'Failed to load record')) ||
      (reviewQuery.error && formatError(reviewQuery.error, 'Failed to load local matches')) ||
      (downloadsQuery.error && formatError(downloadsQuery.error, 'Failed to load import queue')) ||
      null,
    analyzeFile: actions.analyzeFile,
    transcodeToMp3320: actions.transcodeToMp3320,
    assignToRecord: actions.assignToRecord,
    deleteFile: actions.deleteFile,
    replaceExistingSong: actions.replaceExistingSong,
    openUpgradeCase: actions.openUpgradeCase,
    importSingleDownload: actions.importSingleDownload
  }
}

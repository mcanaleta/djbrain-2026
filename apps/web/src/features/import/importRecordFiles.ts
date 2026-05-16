import type { AudioAnalysis, CollectionItemDetails, ImportCommitInput, ImportFileResult, ImportReview } from '@djbrain/shared/api'
import { toTagDraft, toTagPreview, type TagDraft } from '../../lib/importReview.ts'
import type { ImportRow, ImportTracksTableRow } from './importRows'

export type ImportRecordFileKind = 'collection' | 'download'
export type ImportRecordDownloadAction = 'import' | 'replace' | 'delete'
export type ImportRecordFileRow = {
  kind: ImportRecordFileKind
  filename: string
  filesize: number
  duration: number | null
  qualityScore: number | null
  audioAnalysis: AudioAnalysis | null
  prep: string
  download: ImportRow | null
}

function collectionRow(item: CollectionItemDetails): ImportRecordFileRow {
  return {
    kind: 'collection',
    filename: item.filename,
    filesize: item.filesize,
    duration: item.parsedAudioAnalysis?.durationSeconds ?? null,
    qualityScore: null,
    audioAnalysis: item.parsedAudioAnalysis,
    prep: 'collection',
    download: null
  }
}

function downloadRow(item: ImportRow): ImportRecordFileRow {
  return {
    kind: 'download',
    filename: item.filename,
    filesize: item.filesize,
    duration: item.duration,
    qualityScore: item.importQualityScore ?? item.qualityScore ?? null,
    audioAnalysis: item.audioAnalysis ?? null,
    prep: item.prep,
    download: item
  }
}

export function buildImportRecordFileRows(record: ImportTracksTableRow, collectionTarget: CollectionItemDetails | null): ImportRecordFileRow[] {
  return [...(collectionTarget ? [collectionRow(collectionTarget)] : []), ...record.files.map(downloadRow)]
}

export function getImportRecordDownloadActions(hasCollectionTarget: boolean): ImportRecordDownloadAction[] {
  return hasCollectionTarget ? ['replace', 'delete'] : ['import', 'delete']
}

export type ImportActionConfirmation = {
  title: string
  confirmLabel: string
  lines: string[]
}

function tagLine(input: ImportCommitInput): string {
  const tags = input.tags
  return [tags?.artist, tags?.title, tags?.year, tags?.discogsTrackPosition ? `Discogs track ${tags.discogsTrackPosition}` : null].filter(Boolean).join(' - ')
}

export function buildImportActionConfirmation(
  action: Extract<ImportRecordDownloadAction, 'import' | 'replace'>,
  row: ImportRecordFileRow,
  collectionTarget: CollectionItemDetails | null,
  input: ImportCommitInput,
  destinationRelativePath: string | null
): ImportActionConfirmation {
  const destination = destinationRelativePath ?? input.replaceFilename ?? 'the selected songs path'
  return action === 'replace'
    ? {
        title: 'Replace Collection File',
        confirmLabel: 'Replace',
        lines: [
          `Source download: ${row.filename}`,
          `Replace target: ${collectionTarget?.filename ?? input.replaceFilename ?? 'current collection file'}`,
          'The current collection file will be archived first.',
          'The chosen download will be converted to MP3 320 when needed and written with the selected tags.',
          `Tags: ${tagLine(input) || 'selected review tags'}`,
          'After completion this page will stay on this review and refresh the files.'
        ]
      }
    : {
        title: 'Import Download',
        confirmLabel: 'Import',
        lines: [
          `Source download: ${row.filename}`,
          `Create collection file: ${destination}`,
          'The chosen download will be converted to MP3 320 when needed and written with the selected tags.',
          `Tags: ${tagLine(input) || 'selected review tags'}`,
          'After completion this page will stay on this review and refresh the files.'
        ]
      }
}

export function importResultTargetFilename(result: ImportFileResult): string | null {
  if (result.status === 'imported' || result.status === 'imported_upgrade') return result.destRelativePath
  if (result.status === 'replaced') return result.replacedRelativePath
  if (result.status === 'skipped_existing') return result.existingRelativePath
  return null
}

export function buildImportCommitInputFromReview(
  review: ImportReview,
  mode: NonNullable<ImportCommitInput['mode']>,
  replaceFilename: string | null,
  selectedIndex: number | null = review.selectedCandidateIndex,
  tagDraft?: TagDraft
): ImportCommitInput | null {
  const candidate = review.candidates[selectedIndex ?? 0] ?? review.candidates[0] ?? null
  return candidate
    ? {
        filename: review.filename,
        match: candidate.match,
        tags: tagDraft ? toTagPreview(tagDraft) : toTagPreview(toTagDraft(candidate.proposedTags)),
        mode,
        replaceFilename: mode === 'replace_existing' ? replaceFilename : null
      }
    : null
}

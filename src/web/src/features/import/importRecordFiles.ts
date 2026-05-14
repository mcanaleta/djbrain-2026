import type { AudioAnalysis, CollectionItemDetails, ImportCommitInput, ImportReview } from '../../../../shared/api'
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
  return hasCollectionTarget ? ['import', 'replace', 'delete'] : ['import', 'delete']
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

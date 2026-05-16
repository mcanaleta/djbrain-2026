import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CollectionItem, CollectionItemDetails, ImportReview } from '@djbrain/shared/api.ts'
import {
  buildImportActionConfirmation,
  buildImportCommitInputFromReview,
  buildImportRecordFileRows,
  getImportRecordDownloadActions,
  importResultTargetFilename
} from './importRecordFiles.ts'
import { buildImportRows, groupImportRows } from './importRows.ts'

const target: CollectionItemDetails = {
  id: 10,
  filename: 'songs/1995/Mega Lo Mania - Close Your Eyes.mp3',
  filesize: 123,
  mtimeMs: 1,
  isDownload: false,
  recordingId: null,
  identificationStatus: null,
  identificationConfidence: null,
  assignmentMethod: null,
  recordingCanonical: null,
  tags: null,
  importReview: null,
  fileAudioState: null,
  audioAnalysisCache: null,
  qualityScore: 82,
  parsedAudioAnalysis: null,
  identification: null,
  upgradeCase: null
}

function item(filename: string, importTrackKey: string, filesize = 1): CollectionItem {
  return {
    id: Math.random(),
    filename,
    filesize,
    duration: 353,
    isDownload: true,
    score: null,
    bitrateKbps: null,
    qualityScore: null,
    audioAnalysis: null,
    recordingId: null,
    recordingDiscogsUrl: null,
    recordingMusicBrainzUrl: null,
    identificationStatus: 'pending',
    identificationConfidence: null,
    assignmentMethod: null,
    recordingCanonical: null,
    importStatus: 'ready',
    importTrackKey,
    importMatchArtist: "Mega 'Lo Mania",
    importMatchTitle: 'Close Your Eyes',
    importBetterThanExisting: null,
    importExistingQualityScore: null,
    importQualityScore: null
  }
}

describe('buildImportRecordFileRows', () => {
  it('keeps the collection file first and download candidates after it', () => {
    const record = groupImportRows(buildImportRows([
      item('hasoulseek/one.mp3', 'a', 2),
      item('hasoulseek/two.mp3', 'a', 3)
    ]))[0]
    const rows = buildImportRecordFileRows(record!, target)
    assert.deepEqual(rows.map((row) => row.kind), ['collection', 'download', 'download'])
    assert.equal(rows[0]?.filename, target.filename)
    assert.equal(rows[0]?.qualityScore, 82)
  })

  it('exposes replace only when a collection target exists', () => {
    assert.deepEqual(getImportRecordDownloadActions(true), ['replace', 'delete'])
    assert.deepEqual(getImportRecordDownloadActions(false), ['import', 'delete'])
  })

  it('builds direct import and replace inputs from the selected Discogs review candidate', () => {
    const review: ImportReview = {
      filename: 'hasoulseek/one.mp3',
      parsed: null,
      search: { artist: 'A', title: 'T', version: null },
      selectedCandidateIndex: 0,
      candidates: [{
        match: { artist: 'A', title: 'T', version: null, year: '1995', label: null, catalogNumber: null, durationSeconds: 1, releaseId: 1, releaseTitle: 'R', trackPosition: 'A1', format: 'Vinyl', score: 90 },
        proposedTags: { artist: 'A', title: 'T', album: 'R', year: '1995', label: null, catalogNumber: null, trackPosition: 'A1', discogsReleaseId: 1, discogsTrackPosition: 'A1' },
        destinationRelativePath: 'songs/1995/A - T.mp3',
        exactExistingFilename: target.filename
      }, {
        match: { artist: 'B', title: 'U', version: null, year: '1996', label: null, catalogNumber: null, durationSeconds: 2, releaseId: 2, releaseTitle: 'S', trackPosition: 'B1', format: 'CD', score: 80 },
        proposedTags: { artist: 'B', title: 'U', album: 'S', year: '1996', label: null, catalogNumber: null, trackPosition: 'B1', discogsReleaseId: 2, discogsTrackPosition: 'B1' },
        destinationRelativePath: 'songs/1996/B - U.mp3',
        exactExistingFilename: target.filename
      }],
      similarItems: [],
      sourceAnalysis: null,
      tagWriteSupported: true
    }
    assert.equal(buildImportCommitInputFromReview(review, 'import_new', null)?.replaceFilename, null)
    assert.equal(buildImportCommitInputFromReview(review, 'replace_existing', target.filename)?.replaceFilename, target.filename)
    assert.equal(buildImportCommitInputFromReview(review, 'import_new', null, 1)?.match?.releaseId, 2)
  })

  it('explains import and replace confirmations before committing', () => {
    const row = buildImportRecordFileRows(groupImportRows(buildImportRows([item('hasoulseek/one.flac', 'a', 2)]))[0]!, target)[1]!
    const input = {
      filename: row.filename,
      mode: 'replace_existing' as const,
      replaceFilename: target.filename,
      tags: { artist: 'A', title: 'T', album: 'R', year: '1995', label: null, catalogNumber: null, trackPosition: 'A1', discogsReleaseId: 1, discogsTrackPosition: 'A1' }
    }
    const replace = buildImportActionConfirmation('replace', row, target, input, 'songs/1995/A - T.mp3')
    const direct = buildImportActionConfirmation('import', row, null, { ...input, mode: 'import_new', replaceFilename: null }, 'songs/1995/A - T.mp3')

    assert.match(replace.title, /Replace/)
    assert.ok(replace.lines.some((line) => line.includes(target.filename)))
    assert.ok(replace.lines.some((line) => line.includes('MP3 320')))
    assert.ok(direct.lines.some((line) => line.includes('Create collection file')))
    assert.ok(direct.lines.some((line) => line.includes('stay on this review')))
  })

  it('keeps the refreshed collection target from import results', () => {
    assert.equal(importResultTargetFilename({ status: 'imported', destRelativePath: 'songs/a.mp3' }), 'songs/a.mp3')
    assert.equal(importResultTargetFilename({ status: 'replaced', replacedRelativePath: 'songs/b.mp3' }), 'songs/b.mp3')
    assert.equal(importResultTargetFilename({ status: 'needs_review' }), null)
  })
})

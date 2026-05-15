import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CollectionItem } from './api.ts'
import { buildImportRows, groupImportRows } from '../web/src/features/import/importRows.ts'
import { buildImportRecordReviewHref } from '../web/src/lib/urls.ts'

function item(filename: string, importTrackKey: string, filesize = 1, qualityScore: number | null = null): CollectionItem {
  return {
    id: Math.random(),
    filename,
    filesize,
    duration: 353,
    isDownload: true,
    score: null,
    bitrateKbps: null,
    qualityScore: null,
    recordingId: null,
    recordingDiscogsUrl: null,
    recordingMusicBrainzUrl: null,
    identificationStatus: 'pending',
    identificationConfidence: null,
    assignmentMethod: null,
    recordingCanonical: null,
    importStatus: 'ready',
    importArtist: null,
    importTitle: null,
    importVersion: null,
    importYear: null,
    importError: null,
    importTrackKey,
    importMatchArtist: "Mega 'Lo Mania",
    importMatchTitle: 'Close Your Eyes (Vocal Mix)',
    importMatchVersion: null,
    importMatchYear: '1995',
    importReleaseTitle: 'Close Your Eyes',
    importTrackPosition: null,
    importExactExistingFilename: null,
    importBetterThanExisting: null,
    importExistingQualityScore: null,
    importQualityScore: qualityScore
  }
}

describe('groupImportRows', () => {
  it('groups download variants by matched track even when release keys differ', () => {
    const rows = groupImportRows(buildImportRows([
      item('hasoulseek/complete/#MAKINA/Mega`Lo Mania - Close Your Eyes (Vocal Mix).mp3', "93835:2:mega 'lo mania:close your eyes (vocal mix):"),
      item("hasoulseek/complete/Recovered MP3 Renamed/NRR 040. Mega 'Lo Mania - Close Your Eyes (Vocal Mix) .mp3", "165698:b1:mega 'lo mania:close your eyes (vocal mix):")
    ]))

    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.fileCount, 2)
    assert.equal(rows[0]?.files.length, 2)
    assert.equal(rows[0]?.artist, "Mega 'Lo Mania")
    assert.equal(rows[0]?.title, 'Close Your Eyes (Vocal Mix)')
  })

  it('prefers the larger file when only the weaker candidate has an analysis score', () => {
    const rows = groupImportRows(buildImportRows([
      item('hasoulseek/complete/#MAKINA/Mega`Lo Mania - Close Your Eyes (Vocal Mix).mp3', "93835:2:mega 'lo mania:close your eyes (vocal mix):", 14496106),
      item("hasoulseek/complete/Recovered MP3 Renamed/NRR 040. Mega 'Lo Mania - Close Your Eyes (Vocal Mix) .mp3", "165698:b1:mega 'lo mania:close your eyes (vocal mix):", 5677553, 56)
    ]))

    assert.equal(rows[0]?.bestFile.filename, 'hasoulseek/complete/#MAKINA/Mega`Lo Mania - Close Your Eyes (Vocal Mix).mp3')
  })

  it('links review by import record id instead of filename', () => {
    const rows = groupImportRows(buildImportRows([
      item('hasoulseek/complete/#MAKINA/Mega`Lo Mania - Close Your Eyes (Vocal Mix).mp3', "93835:2:mega 'lo mania:close your eyes (vocal mix):")
    ]))
    const recordId = rows[0]?.id
    assert.equal(typeof recordId, 'number')
    assert.ok(recordId > 0)
    const href = buildImportRecordReviewHref(recordId, 'Mega Close Eyes')

    assert.match(href, /^\/import\/review\/\d+\?query=Mega%20Close%20Eyes$/)
    assert.equal(href.includes('recordId='), false)
    assert.equal(href.includes('%3A'), false)
    assert.equal(href.includes('filename='), false)
  })

  it('keeps legacy parsed ids as aliases when a download is assigned to a recording', () => {
    const rows = groupImportRows(buildImportRows([{
      ...item("hasoulseek/complete/UnknownAlbum/A1 - Jog - Future (Remix '98).flac", ''),
      recordingId: 1932,
      recordingCanonical: { artist: 'Jog', title: 'Future', version: "Remix '98", year: '1998' }
    }]))

    assert.equal(rows[0]?.id, 1932)
    assert.ok(rows[0]?.legacyIds.includes(2926488223))
  })

  it('counts the replacement source in total files', () => {
    const rows = groupImportRows(buildImportRows([{
      ...item("hasoulseek/complete/UnknownAlbum/A1 - Jog - Future (Remix '98).flac", ''),
      importExactExistingFilename: "songs/1998/Jog - Future (Remix '98).mp3"
    }]))

    assert.equal(rows[0]?.fileCount, 1)
    assert.equal(rows[0]?.totalFileCount, 2)
  })
})

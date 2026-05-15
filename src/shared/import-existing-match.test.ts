import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDownloadExistingMatchCanonical } from '../backend/collection-service.ts'

describe('buildDownloadExistingMatchCanonical', () => {
  it('falls back to filename parsing for pending download rows', () => {
    assert.deepEqual(
      buildDownloadExistingMatchCanonical({
        filename: "hasoulseek/complete/UnknownAlbum/A1 - Jog - Future (Remix '98).flac",
        importArtist: null,
        importTitle: null,
        importVersion: null,
        importYear: null
      }),
      { artist: 'Jog', title: 'Future', version: "Remix '98", year: null }
    )
  })
})

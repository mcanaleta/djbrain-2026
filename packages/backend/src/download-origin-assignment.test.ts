import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDownloadOriginIdentificationSeed } from '@djbrain/backend/collection-service.ts'

describe('buildDownloadOriginIdentificationSeed', () => {
  it('marks downloader-linked files ready against the origin recording', () => {
    assert.deepEqual(
      buildDownloadOriginIdentificationSeed({
        recordingId: 1932,
        artist: 'Jog',
        title: 'Future',
        version: "Remix '98",
        year: '1998',
        sourceCollectionFilename: "songs/1998/Jog - Future (Remix '98).mp3"
      }, { artist: 'Wrong', title: 'Guess', version: null, year: null }),
      {
        recordingId: 1932,
        status: 'ready',
        assignmentMethod: 'manual',
        confidence: 100,
        parsedArtist: 'Jog',
        parsedTitle: 'Future',
        parsedVersion: "Remix '98",
        parsedYear: '1998'
      }
    )
  })
})

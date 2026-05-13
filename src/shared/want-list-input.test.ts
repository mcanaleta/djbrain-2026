import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildReplacementWantInput } from './want-list-input.ts'
import type { CollectionItemDetails } from './api.ts'

function item(partial: Partial<CollectionItemDetails>): CollectionItemDetails {
  return {
    id: 1,
    filename: 'songs/2008/Darren Styles & Francis Hill - Come Running.mp3',
    filesize: 1,
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
    parsedAudioAnalysis: null,
    identification: null,
    upgradeCase: null,
    ...partial
  }
}

describe('buildReplacementWantInput', () => {
  it('creates a replacement want record from canonical metadata and source filename', () => {
    const input = buildReplacementWantInput(item({
      recordingCanonical: { artist: 'Darren Styles & Francis Hill', title: 'Come Running', version: null, year: '2008' },
      tags: { source: 'id3', artist: 'Tag Artist', title: 'Tag Title', version: null, album: 'Album', year: '2007', label: 'Label', catalogNumber: null, trackPosition: null, discogsReleaseId: 123, discogsTrackPosition: 'A1' }
    }))

    assert.deepEqual(input, {
      wantKind: 'replacement',
      artist: 'Darren Styles & Francis Hill',
      title: 'Come Running',
      version: null,
      year: '2008',
      album: 'Album',
      label: 'Label',
      discogsReleaseId: 123,
      discogsTrackPosition: 'A1',
      discogsEntityType: 'release',
      sourceCollectionFilename: 'songs/2008/Darren Styles & Francis Hill - Come Running.mp3',
      targetDownloadCount: 3,
      autoDownloadEnabled: true
    })
  })
})

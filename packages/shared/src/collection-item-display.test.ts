import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCollectionItemHeading, findDiscogsDisplayTrack } from './collection-item-display.ts'
import type { CollectionItemDetails, RecordingDetails } from './api.ts'

const item = {
  filename: 'hasoulseek/complete/#MAKINA/farmdoctors el guebo.mp3',
  recordingCanonical: { artist: 'Farmdoctors', title: 'El Guebo', version: null, year: '1996' },
  tags: { source: 'file_tag_state', artist: 'Farmdoctors', title: 'El Guebo', version: null, album: 'El Güebo', year: null, label: 'Max Music', catalogNumber: null, trackPosition: null, discogsReleaseId: 552800, discogsTrackPosition: 'Z' },
  upgradeCase: { officialDurationSeconds: 330 }
} as CollectionItemDetails

const recording = { canonical: item.recordingCanonical } as RecordingDetails
const tracks = [
  { position: 'A1', title: 'El Güebo (Commercial Mix)', duration: '5:30', artists: [] },
  { position: 'B1', title: 'El Güebo (Destroy Mix)', duration: '6:10', artists: [] }
]

describe('collection item display helpers', () => {
  it('uses the release track duration when stale Z Discogs tags cannot identify the track', () => {
    assert.equal(findDiscogsDisplayTrack(tracks, 'Z', 'El Guebo', 330)?.position, 'A1')
  })

  it('prefers the resolved Discogs track title in the header', () => {
    const heading = buildCollectionItemHeading(item, recording, tracks[0])
    assert.equal(heading.title, 'Farmdoctors · El Güebo (Commercial Mix) (1996)')
  })
})

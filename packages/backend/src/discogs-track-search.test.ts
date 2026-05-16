import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDiscogsTrackSearchResults } from '@djbrain/backend/discogs-track-search.ts'
import type { DiscogsRelease } from '@djbrain/shared/discogs.ts'

const release: DiscogsRelease = {
  id: 7,
  type: 'release',
  title: 'Close Your Eyes',
  artists: ["Mega 'Lo Mania"],
  year: '1995',
  labels: ['Dos Or Die'],
  catalogNumbers: ['DOS 101'],
  formats: ['Vinyl'],
  genres: [],
  styles: [],
  externalUrl: 'https://www.discogs.com/release/7',
  tracklist: [
    { position: 'A1', title: 'Close Your Eyes (Vocal Mix)', duration: '5:31' },
    { position: 'B1', title: 'Close Your Eyes (Instrumental)', duration: '5:10', artists: ['Alias'] }
  ],
  videos: [{ uri: 'https://www.youtube.com/watch?v=abc123XYZ_0', title: "Mega 'Lo Mania - Close Your Eyes Vocal Mix", duration: 331 }],
  relatedArtists: [],
  relatedLabels: []
}

describe('buildDiscogsTrackSearchResults', () => {
  it('flattens release tracks into selectable Discogs track rows', () => {
    const rows = buildDiscogsTrackSearchResults([release])

    assert.deepEqual(rows.map((row) => ({
      artist: row.artist,
      title: row.title,
      version: row.version,
      releaseTitle: row.releaseTitle,
      year: row.year,
      format: row.format,
      durationSeconds: row.durationSeconds,
      externalUrl: row.externalUrl,
      youtubeVideoId: row.youtubeVideoId,
      youtubeTitle: row.youtubeTitle
    })), [
      {
        artist: "Mega 'Lo Mania",
        title: 'Close Your Eyes',
        version: 'Vocal Mix',
        releaseTitle: 'Close Your Eyes',
        year: '1995',
        format: 'Vinyl',
        durationSeconds: 331,
        externalUrl: 'https://www.discogs.com/release/7',
        youtubeVideoId: 'abc123XYZ_0',
        youtubeTitle: "Mega 'Lo Mania - Close Your Eyes Vocal Mix"
      },
      {
        artist: 'Alias',
        title: 'Close Your Eyes',
        version: 'Instrumental',
        releaseTitle: 'Close Your Eyes',
        year: '1995',
        format: 'Vinyl',
        durationSeconds: 310,
        externalUrl: 'https://www.discogs.com/release/7',
        youtubeVideoId: 'abc123XYZ_0',
        youtubeTitle: "Mega 'Lo Mania - Close Your Eyes Vocal Mix"
      }
    ])
  })
})

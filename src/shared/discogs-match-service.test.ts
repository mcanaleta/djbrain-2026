import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DiscogsMatchService } from '../backend/discogs-match-service.ts'

describe('DiscogsMatchService', () => {
  it('uses track artists instead of Various for compilation track matches', async () => {
    const result = await new DiscogsMatchService().findTrack(
      {} as never,
      'Darren Styles & Francis Hill',
      'Come Running',
      null,
      {
        searchDiscogsReleases: async () => [{ id: 1, type: 'release' }],
        getDiscogsEntity: async () => ({
          id: 1,
          type: 'release',
          title: 'Clubland X-treme Hardcore 4',
          artists: ['Various'],
          year: '2007',
          labels: [],
          catalogNumbers: [],
          formats: ['CD', 'Compilation'],
          genres: [],
          styles: [],
          externalUrl: '',
          tracklist: [{ position: '1-02', title: 'Come Running', artists: ['Darren Styles', 'Francis Hill'] }],
          videos: [],
          relatedArtists: [],
          relatedLabels: []
        })
      } as never
    )

    assert.equal(result.candidates[0]?.artist, 'Darren Styles, Francis Hill')
  })
})

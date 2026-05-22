import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SlskdService } from '@djbrain/backend/slskd-service.ts'

describe('SlskdService.extractCandidates', () => {
  it('drops candidates with durations far from the expected track length', () => {
    const candidates = new SlskdService().extractCandidates('Artist', 'Track', null, {
      id: 's1',
      searchText: 'Artist Track',
      state: 'Completed',
      responses: [{
        username: 'peer',
        hasFreeUploadSlot: true,
        files: [
          { filename: 'Artist - Track short.mp3', size: 8_000_000, length: 120 },
          { filename: 'Artist - Track full.mp3', size: 18_000_000, length: 500 }
        ]
      }]
    }, 502)

    assert.deepEqual(candidates.map((item) => item.filename), ['Artist - Track full.mp3'])
  })
})

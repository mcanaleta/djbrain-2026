import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildTagRepairRows } from './tag-repair.ts'

describe('buildTagRepairRows', () => {
  it('marks matching artist title and year as OK', () => {
    const rows = buildTagRepairRows(
      { source: 'id3', artist: 'Farmdoctors', title: 'El Güebo', version: null, album: null, year: '1996', label: null, catalogNumber: null, trackPosition: null, discogsReleaseId: null, discogsTrackPosition: null },
      { artist: 'farmdoctors', title: 'El Guebo', version: null, year: '1996' }
    )

    assert.deepEqual(rows.map((row) => row.matches), [true, true, true])
  })

  it('exposes current and expected values for mismatches', () => {
    const rows = buildTagRepairRows(
      { source: 'id3', artist: 'Wrong', title: 'Bad', version: null, album: null, year: '0', label: null, catalogNumber: null, trackPosition: null, discogsReleaseId: null, discogsTrackPosition: null },
      { artist: 'Right', title: 'Good', version: null, year: '1998' }
    )

    assert.deepEqual(rows.map(({ field, current, expected, matches }) => ({ field, current, expected, matches })), [
      { field: 'artist', current: 'Wrong', expected: 'Right', matches: false },
      { field: 'title', current: 'Bad', expected: 'Good', matches: false },
      { field: 'year', current: '0', expected: '1998', matches: false }
    ])
  })
})

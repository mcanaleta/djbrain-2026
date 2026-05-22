import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildReplacementArchiveRelativePath } from './replacement-archive.ts'

describe('buildReplacementArchiveRelativePath', () => {
  it('archives collection replacements outside the active songs tree by date', () => {
    assert.equal(
      buildReplacementArchiveRelativePath('songs', 'songs/1998/Jog - Future.mp3', '2026-05-15').replaceAll('\\', '/'),
      '_replaced/2026-05-15/1998/Jog - Future.mp3'
    )
  })
})

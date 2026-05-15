import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildReplacementArchiveRelativePath } from '../server/routes/collection.ts'

describe('buildReplacementArchiveRelativePath', () => {
  it('archives collection replacements under songs/_replaced by date', () => {
    assert.equal(
      buildReplacementArchiveRelativePath('songs', 'songs/1998/Jog - Future.mp3', '2026-05-15').replaceAll('\\', '/'),
      'songs/_replaced/2026-05-15/1998/Jog - Future.mp3'
    )
  })
})

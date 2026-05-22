import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCollectionItemPath } from './collection-url.ts'

describe('buildCollectionItemPath', () => {
  it('uses the stable file id instead of the filename in the URL', () => {
    assert.equal(
      buildCollectionItemPath(42, 'songs/2008/Darren Styles & Francis Hill - Come Running.mp3'),
      '/collection/item/42'
    )
  })
})

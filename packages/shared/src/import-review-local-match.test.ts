import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CollectionItem, ImportReview } from './api.ts'
import { pickImportReviewLocalMatch } from './import-review-local-match.ts'

const localItem = {
  filename: 'songs/1996/Farmdoctors - El Guebo.mp3',
  recordingCanonical: { artist: 'Farmdoctors', title: 'El Guebo', version: null, year: '1996' }
} as CollectionItem

describe('pickImportReviewLocalMatch', () => {
  it('uses canonical local matches only when Discogs has no candidate', () => {
    const review = { candidates: [], similarItems: [localItem] } as unknown as ImportReview
    assert.equal(pickImportReviewLocalMatch(review), localItem)
    assert.equal(pickImportReviewLocalMatch({ ...review, candidates: [{}] } as ImportReview), null)
  })
})

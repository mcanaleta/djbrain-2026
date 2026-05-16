import type { CollectionItem, ImportReview } from './api.ts'

export function pickImportReviewLocalMatch(review: ImportReview | null): CollectionItem | null {
  return review?.candidates.length
    ? null
    : review?.similarItems.find((item) => item.recordingCanonical?.artist && item.recordingCanonical.title) ?? null
}

export type DiscogsTrackMatch = {
  releaseId: number
  releaseTitle: string
  artist: string
  title: string
  version: string | null
  trackPosition: string | null
  year: string | null
  label: string | null
  catalogNumber: string | null
  score: number
}

// Threshold above which a match is considered confident enough for auto-import
export const DISCOGS_CONFIDENT_THRESHOLD = 70

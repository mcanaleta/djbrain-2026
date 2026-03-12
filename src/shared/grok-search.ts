export type GrokTrackResult = {
  artist: string
  title: string
  version: string
  year: string
}

export type GrokSearchResponse = {
  query: string
  total: number
  tracks: GrokTrackResult[]
}

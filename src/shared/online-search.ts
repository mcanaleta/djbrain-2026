export type OnlineSearchSource =
  | 'discogs'
  | 'beatport'
  | 'spotify'
  | 'applemusic'
  | 'youtube'
  | 'unknown'

export type OnlineSearchScope = 'discogs' | 'online' | 'youtube'

export type OnlineSearchCandidate = {
  artist?: string
  artists?: string[]
  title: string
  version?: string
  year?: string
}

export type OnlineSearchItem = {
  source: OnlineSearchSource
  sourceType?: string
  title: string
  link: string
  snippet: string
  displayLink: string
  candidates: OnlineSearchCandidate[]
  label?: string
  catno?: string
  format?: string
}

export type OnlineSearchResponse = {
  query: string
  total: number
  items: OnlineSearchItem[]
  sourceCounts: Partial<Record<OnlineSearchSource, number>>
}

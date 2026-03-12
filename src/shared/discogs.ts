export type DiscogsEntityType = 'release' | 'artist' | 'label' | 'master'

export type DiscogsFact = {
  label: string
  value: string
}

export type DiscogsTrack = {
  position?: string
  title: string
  duration?: string
}

export type DiscogsEntityReference = {
  id?: number
  type: DiscogsEntityType
  name: string
}

export type DiscogsRelatedSection = {
  title: string
  items: DiscogsEntityReference[]
}

export type DiscogsVideo = {
  uri: string
  title: string
}

export type DiscogsEntityDetail = {
  id: number
  type: DiscogsEntityType
  title: string
  subtitle?: string
  summary?: string
  notes?: string
  externalUrl: string
  heroImageUrl?: string
  year?: string
  country?: string
  genres: string[]
  styles: string[]
  urls: string[]
  facts: DiscogsFact[]
  relatedSections: DiscogsRelatedSection[]
  tracklist: DiscogsTrack[]
  videos: DiscogsVideo[]
}

export function buildDiscogsEntityPath(type: DiscogsEntityType, id: number | string): string {
  return `/discogs/${type}/${id}`
}

export function formatDiscogsEntityType(type: DiscogsEntityType): string {
  switch (type) {
    case 'release':
      return 'Release'
    case 'artist':
      return 'Artist'
    case 'label':
      return 'Label'
    case 'master':
      return 'Master Release'
  }
}

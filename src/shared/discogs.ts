export type DiscogsEntityType = 'release' | 'artist' | 'label' | 'master'

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

export type DiscogsVideo = {
  uri: string
  title: string
  duration?: number
}

export type DiscogsRelease = {
  id: number
  type: 'release'
  title: string
  artists: string[]
  year?: string
  country?: string
  labels: string[]
  catalogNumbers: string[]
  formats: string[]
  genres: string[]
  styles: string[]
  externalUrl: string
  heroImageUrl?: string
  tracklist: DiscogsTrack[]
  videos: DiscogsVideo[]
  relatedArtists: DiscogsEntityReference[]
  relatedLabels: DiscogsEntityReference[]
}

export type DiscogsArtist = {
  id: number
  type: 'artist'
  name: string
  realName?: string
  nameVariations: string[]
  profile?: string
  externalUrl: string
  heroImageUrl?: string
  aliases: DiscogsEntityReference[]
  members: DiscogsEntityReference[]
  groups: DiscogsEntityReference[]
}

export type DiscogsLabel = {
  id: number
  type: 'label'
  name: string
  profile?: string
  contactInfo?: string
  externalUrl: string
  heroImageUrl?: string
  parentLabel?: DiscogsEntityReference
  sublabels: DiscogsEntityReference[]
}

export type DiscogsMaster = {
  id: number
  type: 'master'
  title: string
  artists: string[]
  year?: string
  genres: string[]
  styles: string[]
  externalUrl: string
  heroImageUrl?: string
  tracklist: DiscogsTrack[]
  videos: DiscogsVideo[]
  relatedArtists: DiscogsEntityReference[]
  mainRelease?: DiscogsEntityReference
}

export type DiscogsEntity = DiscogsRelease | DiscogsArtist | DiscogsLabel | DiscogsMaster

export function buildDiscogsEntityPath(type: DiscogsEntityType, id: number | string): string {
  return `/discogs/${type}/${id}`
}

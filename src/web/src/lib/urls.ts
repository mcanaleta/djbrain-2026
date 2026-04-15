type IdentifyScope = 'collection' | 'downloads'

const matchUrl = (value: string | null | undefined, pattern: RegExp, build: (id: string) => string): string | null => {
  const match = value?.match(pattern)
  return match ? build(match[1]) : null
}

export const buildDiscogsSearchUrl = (query: string): string =>
  `https://www.discogs.com/search/?q=${encodeURIComponent(query)}&type=all`

export const buildMusicBrainzSearchUrl = (query: string): string =>
  `https://musicbrainz.org/search?query=${encodeURIComponent(query)}&type=recording&method=indexed`

export const buildDiscogsReleaseUrl = (releaseId: number | string): string =>
  `https://www.discogs.com/release/${releaseId}`

export const buildMusicBrainzRecordingUrl = (recordingId: string): string =>
  `https://musicbrainz.org/recording/${recordingId}`

export const discogsReleaseUrlFromExternalKey = (externalKey?: string | null): string | null =>
  matchUrl(externalKey, /discogs:release:(\d+)/i, buildDiscogsReleaseUrl)

export const musicBrainzRecordingUrlFromExternalKey = (externalKey?: string | null): string | null =>
  matchUrl(externalKey, /musicbrainz:recording:([a-f0-9-]+)/i, buildMusicBrainzRecordingUrl)

export const buildImportHref = (query?: string | null): string =>
  query ? `/import?query=${encodeURIComponent(query)}` : '/import'

export const buildImportReviewHref = (filename: string, query?: string | null): string =>
  `/import/review?filename=${encodeURIComponent(filename)}${query ? `&query=${encodeURIComponent(query)}` : ''}`

export const buildIdentifyReviewHref = (filename: string, scope: IdentifyScope): string =>
  `/identify?scope=${scope}&filename=${encodeURIComponent(filename)}`

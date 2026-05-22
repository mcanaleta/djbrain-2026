type IdentifyScope = 'collection' | 'downloads'
type IdentifyFilter = 'all' | 'verified' | 'unverified'

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

export const buildFileHref = (
  id: number | string,
  scope?: IdentifyScope,
  query?: string | null,
  filter: IdentifyFilter = 'unverified'
): string =>
  `/file/${encodeURIComponent(String(id))}${scope ? `?scope=${scope}${query ? `&query=${encodeURIComponent(query)}` : ''}${filter === 'unverified' ? '' : `&filter=${filter}`}` : ''}`

export const buildCollectionItemHref = (id: number | string): string => buildFileHref(id)

export const buildRecordingHref = (recordingId: number | string): string =>
  `/recordings/${encodeURIComponent(String(recordingId))}`

export const buildImportRecordHref = (recordingId: number | string, query?: string | null): string =>
  `/import/${encodeURIComponent(String(recordingId))}${query ? `?query=${encodeURIComponent(query)}` : ''}`

export const buildImportRecordReviewHref = (recordId: number, query?: string | null): string =>
  `/import/review/${encodeURIComponent(String(recordId))}${query ? `?query=${encodeURIComponent(query)}` : ''}`

export const buildIdentifyHref = (scope: IdentifyScope, query?: string | null, filter: IdentifyFilter = 'unverified'): string =>
  `/identify?scope=${scope}${query ? `&query=${encodeURIComponent(query)}` : ''}${filter === 'unverified' ? '' : `&filter=${filter}`}`

export const buildIdentifyReviewHref = (
  id: number,
  scope: IdentifyScope,
  query?: string | null,
  filter: IdentifyFilter = 'unverified'
): string => buildFileHref(id, scope, query, filter)

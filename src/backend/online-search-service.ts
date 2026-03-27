import type {
  OnlineSearchCandidate,
  OnlineSearchItem,
  OnlineSearchResponse,
  OnlineSearchScope,
  OnlineSearchSource
} from '../shared/online-search'
import type {
  DiscogsArtist,
  DiscogsEntityReference,
  DiscogsEntityType,
  DiscogsLabel,
  DiscogsMaster,
  DiscogsRelease,
  DiscogsTrack,
  DiscogsVideo
} from '../shared/discogs'
import type { AppSettings } from './settings-store'

type ProviderMatch = {
  source: OnlineSearchSource
  sourceType?: string
}

type SerperOrganicResult = {
  title?: string
  link?: string
  snippet?: string
}

type SerperResponse = {
  organic?: SerperOrganicResult[]
  message?: string
}

export type DiscogsSearchResult = {
  id?: number
  type?: string
  title?: string
  year?: number | string
  country?: string
  label?: string[]
  format?: string[]
  genre?: string[]
  style?: string[]
  catno?: string
  uri?: string
}

type DiscogsSearchResponse = {
  results?: DiscogsSearchResult[]
  message?: string
}

type JsonObject = Record<string, unknown>

const MAX_RESULTS = 10
const SERPER_SEARCH_ENDPOINT = 'https://google.serper.dev/search'
const DISCOGS_SEARCH_ENDPOINT = 'https://api.discogs.com/database/search'
const DISCOGS_WEB_BASE_URL = 'https://www.discogs.com'
const DISCOGS_USER_AGENT = 'DJBrain/1.0'

const DISCOGS_ROUTE_BY_TYPE: Record<string, string> = {
  release: 'release',
  artist: 'artist',
  label: 'label',
  master: 'master',
  'master release': 'master',
  master_release: 'master'
}

const DISCOGS_API_PATH_BY_TYPE: Record<DiscogsEntityType, string> = {
  release: 'releases',
  artist: 'artists',
  label: 'labels',
  master: 'masters'
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeKey(value: string): string {
  return normalizeText(value).toLowerCase()
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? normalizeText(value) : undefined
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return undefined
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizeText(item))
}

function splitArtists(artist: string): string[] {
  const separators = [',', ' feat.', ' feat ', ' Feat ', ' featuring ', ' Feat.', ' Featuring ']
  for (const separator of separators) {
    if (artist.includes(separator)) {
      return artist
        .split(separator)
        .map((item) => normalizeText(item))
        .filter(Boolean)
    }
  }
  return [normalizeText(artist)].filter(Boolean)
}

function splitTitleVersion(value: string): { title: string; version?: string } {
  const cleaned = normalizeText(value)
    .replace(/\s+\(\d{4}\)$/, '')
    .trim()
  const match = cleaned.match(/^(.+) \((.+)\)$/) || cleaned.match(/^(.*) - (.*)$/)
  if (!match) {
    return { title: cleaned }
  }
  return {
    title: normalizeText(match[1]),
    version: normalizeText(match[2])
  }
}

function splitArtistTitleVersion(text: string): OnlineSearchCandidate {
  const match = normalizeText(text).match(/^(.*) - (.*)$/)
  if (!match) {
    return { title: normalizeText(text) }
  }
  const artist = normalizeText(match[1])
  const titleVersion = splitTitleVersion(match[2])
  return {
    artist,
    artists: splitArtists(artist),
    title: titleVersion.title,
    version: titleVersion.version
  }
}

function findYear(text: string): string | undefined {
  const match = text.match(/\b(19|20)\d{2}\b/)
  return match?.[0]
}

function createCandidate(
  candidate: Partial<OnlineSearchCandidate> & Pick<OnlineSearchCandidate, 'title'>
): OnlineSearchCandidate {
  return {
    artist: candidate.artist ? normalizeText(candidate.artist) : undefined,
    artists: candidate.artists?.map((item: string) => normalizeText(item)).filter(Boolean),
    title: normalizeText(candidate.title),
    version: candidate.version ? normalizeText(candidate.version) : undefined,
    year: candidate.year ? normalizeText(candidate.year) : undefined
  }
}

function dedupeCandidates(candidates: OnlineSearchCandidate[]): OnlineSearchCandidate[] {
  const seen = new Set<string>()
  const result: OnlineSearchCandidate[] = []
  for (const candidate of candidates) {
    const key = [
      normalizeKey(candidate.artist ?? ''),
      normalizeKey(candidate.title),
      normalizeKey(candidate.version ?? ''),
      normalizeKey(candidate.year ?? '')
    ].join('|')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function matchDiscogs(link: string): ProviderMatch | null {
  const match = link.match(/discogs\.com\/(?:[^/]+\/)?(release|artist|label|master)\/(\d+)/i)
  if (!match) {
    return null
  }
  return {
    source: 'discogs',
    sourceType: normalizeDiscogsType(match[1])
  }
}

function matchBeatport(link: string): ProviderMatch | null {
  const match = link.match(/beatport\.com\/(track|release|chart|artist)\/[^/]+\/(\d+)/i)
  if (!match) {
    return null
  }
  return {
    source: 'beatport',
    sourceType: match[1].toLowerCase()
  }
}

function matchSpotify(link: string): ProviderMatch | null {
  const match = link.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([^/?#]+)/i)
  if (!match) {
    return null
  }
  return {
    source: 'spotify',
    sourceType: match[1].toLowerCase()
  }
}

function matchAppleMusic(link: string): ProviderMatch | null {
  const match = link.match(/music\.apple\.com\/(?:[^/]+\/)?(album|song|playlist)\/[^/?#]+\/(\d+)/i)
  if (!match) {
    return null
  }
  return {
    source: 'applemusic',
    sourceType: match[1].toLowerCase()
  }
}

function matchYouTube(link: string): ProviderMatch | null {
  if (!/youtube\.com\/watch\?/i.test(link) && !/youtu\.be\//i.test(link)) {
    return null
  }
  return {
    source: 'youtube',
    sourceType: 'video'
  }
}

function identifyProvider(link: string): ProviderMatch {
  return (
    matchDiscogs(link) ??
    matchBeatport(link) ??
    matchSpotify(link) ??
    matchAppleMusic(link) ??
    matchYouTube(link) ?? {
      source: 'unknown'
    }
  )
}

function parseDiscogsCandidates(
  item: Pick<OnlineSearchItem, 'title' | 'snippet'>
): OnlineSearchCandidate[] {
  const candidates: OnlineSearchCandidate[] = []
  const match = item.title.match(/(.+) [–-] (.+) \((.*), (.*)\) [–-] Discogs/)
  if (!match) {
    return candidates
  }

  const artist = normalizeText(match[1])
  const releaseTitle = normalizeText(match[2])
  const year = findYear(match[3])
  const trackMatches = item.snippet.matchAll(/,\s+([^,]+?),\s+\d+:\d+/g)
  for (const trackMatch of trackMatches) {
    const trackTitle = normalizeText(trackMatch[1].split('(')[0] ?? '')
    if (!trackTitle) {
      continue
    }
    candidates.push(
      createCandidate({
        artist,
        artists: splitArtists(artist),
        title: trackTitle,
        year
      })
    )
  }

  candidates.push(
    createCandidate({
      artist,
      artists: splitArtists(artist),
      title: releaseTitle,
      year
    })
  )

  return dedupeCandidates(candidates)
}

function parseBeatportCandidates(
  item: Pick<OnlineSearchItem, 'title' | 'snippet'>
): OnlineSearchCandidate[] {
  const match = item.title.match(/(.+) by (.+) on Beatport/)
  if (!match) {
    return []
  }

  const artist = normalizeText(match[2])
  const titleVersion = splitTitleVersion(match[1])
  return [
    createCandidate({
      artist,
      artists: splitArtists(artist),
      title: titleVersion.title,
      version: titleVersion.version,
      year: findYear(item.snippet)
    })
  ]
}

function parseSpotifyCandidates(
  item: Pick<OnlineSearchItem, 'title' | 'snippet'>
): OnlineSearchCandidate[] {
  const match = item.title.match(/(.+) - song by (.+) \| Spotify/)
  if (!match) {
    return []
  }

  const artist = normalizeText(match[2])
  const titleVersion = splitTitleVersion(match[1])
  return [
    createCandidate({
      artist,
      artists: splitArtists(artist),
      title: titleVersion.title,
      version: titleVersion.version,
      year: findYear(item.snippet)
    })
  ]
}

function parseAppleMusicCandidates(
  item: Pick<OnlineSearchItem, 'title' | 'snippet'>
): OnlineSearchCandidate[] {
  const match = item.title.match(/(.+) - .* by (.+) on Apple Music/)
  if (!match) {
    return []
  }

  const artist = normalizeText(match[2])
  const titleVersion = splitTitleVersion(match[1])
  return [
    createCandidate({
      artist,
      artists: splitArtists(artist),
      title: titleVersion.title,
      version: titleVersion.version,
      year: findYear(item.snippet)
    })
  ]
}

function parseYouTubeCandidates(
  item: Pick<OnlineSearchItem, 'title' | 'snippet'>
): OnlineSearchCandidate[] {
  const cleanedTitle = normalizeText(item.title.replace(/-\s*YouTube\s*$/i, ''))
  if (!cleanedTitle) {
    return []
  }
  const parsed = splitArtistTitleVersion(cleanedTitle)
  if (!parsed.artist) {
    return []
  }
  return [
    createCandidate({
      artist: parsed.artist,
      artists: parsed.artists,
      title: parsed.title,
      version: parsed.version,
      year: findYear(item.snippet)
    })
  ]
}

function parseCandidates(
  source: OnlineSearchSource,
  item: Pick<OnlineSearchItem, 'title' | 'snippet'>
): OnlineSearchCandidate[] {
  switch (source) {
    case 'discogs':
      return parseDiscogsCandidates(item)
    case 'beatport':
      return parseBeatportCandidates(item)
    case 'spotify':
      return parseSpotifyCandidates(item)
    case 'applemusic':
      return parseAppleMusicCandidates(item)
    case 'youtube':
      return parseYouTubeCandidates(item)
    default:
      return []
  }
}

function ensureSerperConfigured(settings: AppSettings): string {
  const apiKey = settings.serperApiKey.trim()
  if (!apiKey) {
    throw new Error('Serper API key is required. Configure it in Settings.')
  }
  return apiKey
}

function ensureDiscogsConfigured(settings: AppSettings): string {
  const token = settings.discogsUserToken.trim()
  if (!token) {
    throw new Error('Discogs user token is required. Configure it in Settings.')
  }
  return token
}

function normalizeScope(value: unknown): OnlineSearchScope {
  if (value === 'discogs') {
    return 'discogs'
  }
  if (value === 'youtube') {
    return 'youtube'
  }
  return 'online'
}

function buildSerperQuery(query: string, scope: OnlineSearchScope): string {
  if (scope === 'discogs') {
    return `site:discogs.com ${query}`
  }
  if (scope === 'youtube') {
    return `site:youtube.com OR site:youtu.be ${query}`
  }
  return query
}

function deriveDisplayLink(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function isSerperResponse(value: unknown): value is SerperResponse {
  return typeof value === 'object' && value !== null
}

function isDiscogsSearchResponse(value: unknown): value is DiscogsSearchResponse {
  return typeof value === 'object' && value !== null
}

async function requestSerperResults(
  apiKey: string,
  query: string,
  scope: OnlineSearchScope
): Promise<SerperOrganicResult[]> {
  const response = await fetch(SERPER_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey
    },
    body: JSON.stringify({
      q: buildSerperQuery(query, scope),
      num: MAX_RESULTS
    })
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      isSerperResponse(payload) && typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : `Serper request failed with ${response.status} ${response.statusText}.`
    throw new Error(message)
  }

  if (!isSerperResponse(payload)) {
    throw new Error('Serper returned an invalid response.')
  }

  return Array.isArray(payload.organic) ? payload.organic : []
}

function normalizeDiscogsArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizeText(item))
}

function normalizeDiscogsYear(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(value)
  }

  if (typeof value === 'string' && value.trim()) {
    return findYear(value)
  }

  return undefined
}

function normalizeDiscogsType(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  const normalized = normalizeText(value).toLowerCase()
  return DISCOGS_ROUTE_BY_TYPE[normalized]
    ? normalized === 'master' ? 'master release' : normalized
    : undefined
}

function normalizeDiscogsEntityType(value: unknown): DiscogsEntityType | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  const normalized = normalizeText(value).toLowerCase()
  const route = DISCOGS_ROUTE_BY_TYPE[normalized]
  if (!route) {
    return null
  }

  return route === 'master' ? 'master' : (route as DiscogsEntityType)
}

function createReference(
  idValue: unknown,
  nameValue: unknown,
  type: DiscogsEntityType
): DiscogsEntityReference | null {
  const name = normalizeOptionalText(nameValue)
  if (!name) {
    return null
  }

  return {
    id: normalizePositiveInteger(idValue),
    type,
    name
  }
}

function createReferenceFromRecord(
  value: unknown,
  type: DiscogsEntityType,
  nameKey: 'name' | 'title' = 'name'
): DiscogsEntityReference | null {
  if (!isRecord(value)) {
    return null
  }
  return createReference(value.id, value[nameKey], type)
}

function normalizeReferences(
  value: unknown,
  type: DiscogsEntityType,
  nameKey: 'name' | 'title' = 'name'
): DiscogsEntityReference[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => createReferenceFromRecord(item, type, nameKey))
    .filter((item): item is DiscogsEntityReference => item !== null)
}

function normalizeTracklist(value: unknown): DiscogsTrack[] {
  if (!Array.isArray(value)) {
    return []
  }

  const tracks: Array<DiscogsTrack | null> = value.map((item) => {
    if (!isRecord(item)) {
      return null
    }

    const title = normalizeOptionalText(item.title)
    if (!title) {
      return null
    }

    return {
      position: normalizeOptionalText(item.position),
      title,
      duration: normalizeOptionalText(item.duration)
    }
  })

  return tracks.filter((item): item is DiscogsTrack => item !== null)
}

function normalizeImageUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }

    const uri = normalizeOptionalText(item.uri)
    if (uri) {
      return uri
    }

    const thumb = normalizeOptionalText(item.uri150)
    if (thumb) {
      return thumb
    }
  }

  return undefined
}

function buildDiscogsExternalUrl(type: DiscogsEntityType, id: number): string {
  return `${DISCOGS_WEB_BASE_URL}/${DISCOGS_ROUTE_BY_TYPE[type]}/${id}`
}


function normalizeReleaseFormats(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null
      }

      const name = normalizeOptionalText(item.name)
      const descriptions = normalizeStringArray(item.descriptions)
      const parts = [name, descriptions.join(', ')].filter(Boolean)
      return parts.length > 0 ? parts.join(' · ') : null
    })
    .filter((item): item is string => Boolean(item))
}

function normalizeCatalogNumbers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null
      }
      return normalizeOptionalText(item.catno)
    })
    .filter((item): item is string => Boolean(item))
}

async function requestDiscogsResource(
  userToken: string,
  path: string
): Promise<JsonObject> {
  const response = await fetch(`${DISCOGS_WEB_BASE_URL.replace('www.', 'api.')}/${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Discogs token=${userToken}`,
      'User-Agent': DISCOGS_USER_AGENT
    }
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : `Discogs request failed with ${response.status} ${response.statusText}.`
    throw new Error(message)
  }

  if (!isRecord(payload)) {
    throw new Error('Discogs returned an invalid response.')
  }

  return payload
}

function normalizeVideos(value: unknown): DiscogsVideo[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.reduce<DiscogsVideo[]>((acc, item) => {
    if (!isRecord(item)) return acc
    const uri = normalizeOptionalText(item.uri)
    const title = normalizeOptionalText(item.title) ?? ''
    if (uri && /youtube\.com|youtu\.be/i.test(uri)) {
      const duration = typeof item.duration === 'number' && item.duration > 0 ? item.duration : undefined
      acc.push({ uri, title, duration })
    }
    return acc
  }, [])
}

function parseReleaseDetail(payload: JsonObject, id: number): DiscogsRelease {
  const artists = normalizeReferences(payload.artists, 'artist')
  const labels = normalizeReferences(payload.labels, 'label')
  return {
    id,
    type: 'release',
    title: normalizeOptionalText(payload.title) ?? `Release ${id}`,
    artists: artists.map((a) => a.name),
    year: normalizeDiscogsYear(payload.year),
    country: normalizeOptionalText(payload.country),
    labels: labels.map((l) => l.name),
    catalogNumbers: normalizeCatalogNumbers(payload.labels),
    formats: normalizeReleaseFormats(payload.formats),
    genres: normalizeStringArray(payload.genres),
    styles: normalizeStringArray(payload.styles),
    externalUrl: normalizeOptionalText(payload.uri) ?? buildDiscogsExternalUrl('release', id),
    heroImageUrl: normalizeImageUrl(payload.images),
    tracklist: normalizeTracklist(payload.tracklist),
    videos: normalizeVideos(payload.videos),
    relatedArtists: artists,
    relatedLabels: labels
  }
}

function parseArtistDetail(payload: JsonObject, id: number): DiscogsArtist {
  return {
    id,
    type: 'artist',
    name: normalizeOptionalText(payload.name) ?? `Artist ${id}`,
    realName: normalizeOptionalText(payload.realname),
    nameVariations: normalizeStringArray(payload.namevariations),
    profile: normalizeOptionalText(payload.profile),
    externalUrl: normalizeOptionalText(payload.uri) ?? buildDiscogsExternalUrl('artist', id),
    heroImageUrl: normalizeImageUrl(payload.images),
    aliases: normalizeReferences(payload.aliases, 'artist'),
    members: normalizeReferences(payload.members, 'artist'),
    groups: normalizeReferences(payload.groups, 'artist')
  }
}

function parseLabelDetail(payload: JsonObject, id: number): DiscogsLabel {
  const parentLabel = createReferenceFromRecord(payload.parent_label, 'label')
  return {
    id,
    type: 'label',
    name: normalizeOptionalText(payload.name) ?? `Label ${id}`,
    profile: normalizeOptionalText(payload.profile),
    contactInfo: normalizeOptionalText(payload.contact_info),
    externalUrl: normalizeOptionalText(payload.uri) ?? buildDiscogsExternalUrl('label', id),
    heroImageUrl: normalizeImageUrl(payload.images),
    parentLabel: parentLabel ?? undefined,
    sublabels: normalizeReferences(payload.sublabels, 'label')
  }
}

function parseMasterDetail(payload: JsonObject, id: number): DiscogsMaster {
  const artists = normalizeReferences(payload.artists, 'artist')
  const mainReleaseId = normalizePositiveInteger(payload.main_release)
  return {
    id,
    type: 'master',
    title: normalizeOptionalText(payload.title) ?? `Master Release ${id}`,
    artists: artists.map((a) => a.name),
    year: normalizeDiscogsYear(payload.year),
    genres: normalizeStringArray(payload.genres),
    styles: normalizeStringArray(payload.styles),
    externalUrl: normalizeOptionalText(payload.uri) ?? buildDiscogsExternalUrl('master', id),
    heroImageUrl: normalizeImageUrl(payload.images),
    tracklist: normalizeTracklist(payload.tracklist),
    videos: normalizeVideos(payload.videos),
    relatedArtists: artists,
    mainRelease: mainReleaseId
      ? { id: mainReleaseId, type: 'release', name: `Release ${mainReleaseId}` }
      : undefined
  }
}

function buildDiscogsSnippet(result: DiscogsSearchResult): string {
  const parts = [
    normalizeDiscogsYear(result.year),
    typeof result.country === 'string' && result.country.trim()
      ? normalizeText(result.country)
      : undefined,
    ...normalizeDiscogsArray(result.label),
    ...normalizeDiscogsArray(result.format),
    ...normalizeDiscogsArray(result.genre),
    ...normalizeDiscogsArray(result.style),
    typeof result.catno === 'string' && result.catno.trim() ? normalizeText(result.catno) : undefined
  ].filter((value): value is string => Boolean(value))

  return parts.join(' · ')
}

function deriveDiscogsLink(result: DiscogsSearchResult): string {
  if (typeof result.uri === 'string' && result.uri.trim()) {
    return new URL(result.uri, DISCOGS_WEB_BASE_URL).toString()
  }

  const normalizedType = normalizeDiscogsType(result.type)
  const route = normalizedType ? DISCOGS_ROUTE_BY_TYPE[normalizedType] : undefined
  if (!route || typeof result.id !== 'number' || !Number.isFinite(result.id)) {
    return ''
  }

  return `${DISCOGS_WEB_BASE_URL}/${route}/${result.id}`
}

function buildDiscogsCandidates(result: DiscogsSearchResult): OnlineSearchCandidate[] {
  const title = typeof result.title === 'string' ? normalizeText(result.title) : ''
  if (!title) {
    return []
  }

  const parsed = splitArtistTitleVersion(title)
  if (!parsed.artist) {
    return [
      createCandidate({
        title,
        year: normalizeDiscogsYear(result.year)
      })
    ]
  }

  return [
    createCandidate({
      artist: parsed.artist,
      artists: parsed.artists,
      title: parsed.title,
      version: parsed.version,
      year: normalizeDiscogsYear(result.year)
    })
  ]
}

async function requestDiscogsResults(
  userToken: string,
  query: string
): Promise<DiscogsSearchResult[]> {
  const url = new URL(DISCOGS_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('per_page', String(MAX_RESULTS))

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Discogs token=${userToken}`,
      'User-Agent': DISCOGS_USER_AGENT
    }
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      isDiscogsSearchResponse(payload) &&
      typeof payload.message === 'string' &&
      payload.message.trim()
        ? payload.message.trim()
        : `Discogs request failed with ${response.status} ${response.statusText}.`
    throw new Error(message)
  }

  if (!isDiscogsSearchResponse(payload)) {
    throw new Error('Discogs returned an invalid response.')
  }

  return Array.isArray(payload.results) ? payload.results : []
}

export class OnlineSearchService {
  public async search(
    settings: AppSettings,
    queryValue: unknown,
    scopeValue: unknown = 'online'
  ): Promise<OnlineSearchResponse> {
    const query = typeof queryValue === 'string' ? normalizeText(queryValue) : ''
    if (!query) {
      throw new Error('Search query is required.')
    }

    const scope = normalizeScope(scopeValue)
    const items =
      scope === 'discogs'
        ? (
            await requestDiscogsResults(ensureDiscogsConfigured(settings), query)
          )
            .map((result) => this.toDiscogsSearchItem(result))
            .filter((item): item is OnlineSearchItem => item !== null)
        : (
            await requestSerperResults(ensureSerperConfigured(settings), query, scope)
          )
            .map((result) => this.toOnlineSearchItem(result))
            .filter((item): item is OnlineSearchItem => item !== null)
            .filter((item) => (scope === 'youtube' ? item.source === 'youtube' : true))

    const sourceCounts = items.reduce<Partial<Record<OnlineSearchSource, number>>>(
      (counts, item) => {
        counts[item.source] = (counts[item.source] ?? 0) + 1
        return counts
      },
      {}
    )

    return {
      query,
      total: items.length,
      items,
      sourceCounts
    }
  }

  public async searchDiscogsReleases(
    settings: AppSettings,
    query: string
  ): Promise<DiscogsSearchResult[]> {
    return requestDiscogsResults(ensureDiscogsConfigured(settings), query)
  }

  public async getDiscogsEntity(
    settings: AppSettings,
    typeValue: unknown,
    idValue: unknown
  ): Promise<DiscogsRelease | DiscogsArtist | DiscogsLabel | DiscogsMaster> {
    const type = normalizeDiscogsEntityType(typeValue)
    if (!type) {
      throw new Error('Discogs entity type is invalid.')
    }

    const id = normalizePositiveInteger(idValue)
    if (!id) {
      throw new Error('Discogs entity id is invalid.')
    }

    const payload = await requestDiscogsResource(
      ensureDiscogsConfigured(settings),
      `${DISCOGS_API_PATH_BY_TYPE[type]}/${id}`
    )

    switch (type) {
      case 'release':
        return parseReleaseDetail(payload, id)
      case 'artist':
        return parseArtistDetail(payload, id)
      case 'label':
        return parseLabelDetail(payload, id)
      case 'master':
        return parseMasterDetail(payload, id)
    }
  }

  private toOnlineSearchItem(result: SerperOrganicResult): OnlineSearchItem | null {
    const link = typeof result.link === 'string' ? normalizeText(result.link) : ''
    if (!link) {
      return null
    }

    const title =
      typeof result.title === 'string' && result.title.trim() ? normalizeText(result.title) : link
    const snippet =
      typeof result.snippet === 'string' && result.snippet.trim()
        ? normalizeText(result.snippet)
        : ''

    const provider = identifyProvider(link)
    const item: OnlineSearchItem = {
      source: provider.source,
      sourceType: provider.sourceType,
      title,
      link,
      snippet,
      displayLink: deriveDisplayLink(link),
      candidates: []
    }
    item.candidates = parseCandidates(item.source, item)
    return item
  }

  private toDiscogsSearchItem(result: DiscogsSearchResult): OnlineSearchItem | null {
    const title = typeof result.title === 'string' ? normalizeText(result.title) : ''
    const link = deriveDiscogsLink(result)
    if (!title || !link) {
      return null
    }

    return {
      source: 'discogs',
      sourceType: normalizeDiscogsType(result.type),
      title,
      link,
      snippet: buildDiscogsSnippet(result),
      displayLink: deriveDisplayLink(link),
      candidates: buildDiscogsCandidates(result),
      label: normalizeDiscogsArray(result.label)[0],
      catno: typeof result.catno === 'string' && result.catno.trim() ? normalizeText(result.catno) : undefined,
      format: normalizeDiscogsArray(result.format)[0]
    }
  }
}

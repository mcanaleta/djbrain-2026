import type { OnlineSearchCandidate, OnlineSearchItem, OnlineSearchResponse } from '../shared/online-search.ts'
import type { AppSettings } from './settings-store.ts'

type YouTubeSearchItemId = {
  kind?: string
  videoId?: string
}

type YouTubeSearchItemSnippet = {
  title?: string
  description?: string
  channelTitle?: string
  publishedAt?: string
}

type YouTubeSearchItem = {
  id?: YouTubeSearchItemId
  snippet?: YouTubeSearchItemSnippet
}

type YouTubeSearchResponse = {
  items?: YouTubeSearchItem[]
  error?: {
    message?: string
  }
}

const YOUTUBE_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search'
const MAX_RESULTS = 10

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? normalizeText(value) : undefined
}

function findYear(text: string): string | undefined {
  const match = text.match(/\b(19|20)\d{2}\b/)
  return match?.[0]
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

function parseCandidate(title: string, description: string, publishedAt?: string): OnlineSearchCandidate[] {
  const cleanedTitle = normalizeText(title.replace(/-\s*YouTube\s*$/i, ''))
  const match = cleanedTitle.match(/^(.*) - (.*)$/)
  if (!match) {
    return []
  }

  const artist = normalizeText(match[1])
  const titleVersion = splitTitleVersion(match[2])
  return [
    {
      artist,
      artists: splitArtists(artist),
      title: titleVersion.title,
      version: titleVersion.version,
      year: findYear(description) ?? normalizeOptionalText(publishedAt)?.slice(0, 4)
    }
  ]
}

function ensureConfigured(settings: AppSettings): string {
  const apiKey = settings.youtubeApiKey.trim()
  if (!apiKey) {
    throw new Error('YouTube Data API key is required. Configure it in Settings.')
  }
  return apiKey
}

function toSearchItem(item: YouTubeSearchItem): OnlineSearchItem | null {
  const videoId = normalizeOptionalText(item.id?.videoId)
  const title = normalizeOptionalText(item.snippet?.title)
  if (!videoId || !title) {
    return null
  }

  const description = normalizeOptionalText(item.snippet?.description) ?? ''
  const channelTitle = normalizeOptionalText(item.snippet?.channelTitle)
  const snippet = channelTitle ? `${channelTitle}${description ? ` — ${description}` : ''}` : description

  return {
    source: 'youtube',
    sourceType: 'video',
    title,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    snippet,
    displayLink: 'youtube.com',
    candidates: parseCandidate(title, description, item.snippet?.publishedAt)
  }
}

export class YouTubeApiService {
  public async search(settings: AppSettings, queryValue: unknown): Promise<OnlineSearchResponse> {
    const query = typeof queryValue === 'string' ? normalizeText(queryValue) : ''
    if (!query) {
      throw new Error('Search query is required.')
    }

    const url = new URL(YOUTUBE_SEARCH_ENDPOINT)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('type', 'video')
    url.searchParams.set('maxResults', String(MAX_RESULTS))
    url.searchParams.set('q', query)
    url.searchParams.set('key', ensureConfigured(settings))

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json'
      }
    })

    let payload: YouTubeSearchResponse | null = null
    try {
      payload = (await response.json()) as YouTubeSearchResponse
    } catch {
      payload = null
    }

    if (!response.ok) {
      const message =
        payload?.error?.message && payload.error.message.trim()
          ? payload.error.message.trim()
          : `YouTube API request failed with ${response.status} ${response.statusText}.`
      throw new Error(message)
    }

    const items = (payload?.items ?? []).map(toSearchItem).filter((item): item is OnlineSearchItem => item !== null)

    return {
      query,
      total: items.length,
      items,
      sourceCounts: {
        youtube: items.length
      }
    }
  }
}

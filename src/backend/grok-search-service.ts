import { generateText } from 'ai'
import { createXai } from '@ai-sdk/xai'
import type { GrokSearchResponse, GrokTrackResult } from '../shared/grok-search'
import type { AppSettings } from './settings-store'

const GROK_MODEL = 'grok-4-1-fast-reasoning'
const MAX_TRACKS = 30

type JsonRecord = Record<string, unknown>

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? normalizeText(value) : ''
}

function normalizeYear(value: unknown): string {
  const candidate = normalizeString(value)
  const match = candidate.match(/\b(19|20)\d{2}\b/)
  return match?.[0] ?? ''
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function ensureGrokConfigured(settings: AppSettings): string {
  const apiKey = settings.grokApiKey.trim()
  if (!apiKey) {
    throw new Error('Grok API key is required. Configure it in Settings.')
  }
  return apiKey
}

function sanitizeJsonPayload(value: string): string {
  const cleaned = value.trim()
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  return cleaned
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function extractJsonPayload(value: string): unknown {
  const direct = tryParseJson(sanitizeJsonPayload(value))
  if (direct !== null) {
    return direct
  }

  const objectMatch = value.match(/\{[\s\S]*\}/)
  if (objectMatch?.[0]) {
    const parsedObject = tryParseJson(objectMatch[0])
    if (parsedObject !== null) {
      return parsedObject
    }
  }

  const arrayMatch = value.match(/\[[\s\S]*\]/)
  if (arrayMatch?.[0]) {
    const parsedArray = tryParseJson(arrayMatch[0])
    if (parsedArray !== null) {
      return parsedArray
    }
  }

  return null
}

function normalizeTrack(value: unknown): GrokTrackResult | null {
  if (!isRecord(value)) {
    return null
  }

  const artist = normalizeString(value.artist)
  const title = normalizeString(value.title)
  if (!artist || !title) {
    return null
  }

  return {
    artist,
    title,
    version: normalizeString(value.version),
    year: normalizeYear(value.year)
  }
}

function dedupeTracks(tracks: GrokTrackResult[]): GrokTrackResult[] {
  const seen = new Set<string>()
  const output: GrokTrackResult[] = []

  for (const track of tracks) {
    const key = [track.artist.toLowerCase(), track.title.toLowerCase(), track.version.toLowerCase()]
      .map((part) => normalizeText(part))
      .join('|')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    output.push(track)
    if (output.length >= MAX_TRACKS) {
      break
    }
  }

  return output
}

function parseTracksFromModelOutput(value: string): GrokTrackResult[] {
  const payload = extractJsonPayload(value)
  if (payload === null) {
    return []
  }

  const rawTracks = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.tracks)
      ? payload.tracks
      : []

  return dedupeTracks(rawTracks.map((item) => normalizeTrack(item)).filter((item): item is GrokTrackResult => item !== null))
}

export class GrokSearchService {
  public async search(settings: AppSettings, queryValue: unknown): Promise<GrokSearchResponse> {
    const query = typeof queryValue === 'string' ? normalizeText(queryValue) : ''
    if (!query) {
      throw new Error('Search query is required.')
    }

    const xai = createXai({
      apiKey: ensureGrokConfigured(settings)
    })

    const response = await generateText({
      model: xai.responses(GROK_MODEL),
      tools: {
        web_search: xai.tools.webSearch()
      },
      toolChoice: 'auto',
      temperature: 0,
      maxOutputTokens: 1200,
      system:
        'You are a music discovery assistant. Return only valid JSON. No markdown. No explanations.',
      prompt: [
        'Search online for music tracks matching this query and return likely matches as JSON.',
        'Use this exact schema: {"tracks":[{"artist":"string","title":"string","version":"string","year":"string"}]}',
        'Rules:',
        `- Return at most ${MAX_TRACKS} tracks.`,
        '- Each item must be one track.',
        '- artist and title are required non-empty strings.',
        '- version can be empty string when unknown.',
        '- year must be 4-digit year string when known, otherwise empty string.',
        `Query: ${query}`
      ].join('\n')
    })

    const tracks = parseTracksFromModelOutput(response.text)
    return {
      query,
      total: tracks.length,
      tracks
    }
  }
}

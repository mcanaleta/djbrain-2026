import { parseTrackTitle } from './track-title-parser.ts'

export type ParsedImportFilename = {
  artist: string
  title: string
  version: string | null
  year: string | null
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function normalizeText(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripTrackPrefix(value: string): string {
  return value
    .replace(/^\(?[a-z]?\d+[a-z]?\)?[._\-\s]+/i, '')
    .replace(/^track\s*\d+[._\-\s]*/i, '')
    .trim()
}

function stripTrackMarker(value: string): string {
  return value.replace(/^(?:side\s*)?(?:[a-d]\d{1,2}[a-z]?|aa\d{1,2}|bb\d{1,2})\s*[-–—:]\s*/i, '').trim()
}

function stripGarbageSuffix(value: string): string {
  return value
    .replace(/\s+\d{6,}$/i, '')
    .replace(/[-_](?:bc)$/i, '')
    .trim()
}

function cleanTrackSegment(value: string): string {
  return stripGarbageSuffix(stripTrackMarker(value.trim()))
}

function extractGroup(value: string, open: string, close: string): { value: string; rest: string } | null {
  if (!value.startsWith(open)) return null
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === open) depth += 1
    if (value[index] !== close) continue
    depth -= 1
    if (depth === 0) {
      return {
        value: value.slice(1, index).trim(),
        rest: value.slice(index + 1).trim()
      }
    }
  }
  return null
}

function parseDashed(value: string, year: string | null): ParsedImportFilename | null {
  const separatorIndex = value.indexOf(' - ')
  if (separatorIndex <= 0) return null
  const left = value.slice(0, separatorIndex).trim()
  const right = value.slice(separatorIndex + 3).trim()
  const reverse =
    /\b(?:mix|remix|edit|version|dub|instrumental|vocal)\b/i.test(left) &&
    !/\b(?:mix|remix|edit|version|dub|instrumental|vocal)\b/i.test(right)
  const artist = reverse ? right : left
  const parsedTitle = parseTrackTitle(cleanTrackSegment(reverse ? left : right))
  return artist && parsedTitle.title
    ? { artist, title: parsedTitle.title, version: parsedTitle.version, year }
    : null
}

function parseLooseDashed(value: string, year: string | null): ParsedImportFilename | null {
  if (value.includes(' - ')) return null
  const separatorIndex = value.indexOf('-')
  if (separatorIndex <= 0) return null
  const left = value.slice(0, separatorIndex).trim()
  const right = value.slice(separatorIndex + 1).trim()
  if ((!left.includes(' ') && left.length < 3) || !right) return null
  const parsedTitle = parseTrackTitle(cleanTrackSegment(right))
  return left && parsedTitle.title ? { artist: left, title: parsedTitle.title, version: parsedTitle.version, year } : null
}

export function parseImportFilename(filename: string): ParsedImportFilename | null {
  const normalizedPath = filename.replace(/\\/g, '/')
  const parts = normalizedPath.split('/').filter(Boolean)
  const basename = parts[parts.length - 1] ?? filename
  const years = [...normalizedPath.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/g)].map((match) => match[1])
  const year = years.at(-1) ?? null
  const raw = stripTrackPrefix(normalizeText(stripExtension(basename)))
  const direct = parseDashed(raw, year)
  if (direct) return direct

  const bracketArtist = extractGroup(raw, '[', ']')
  if (bracketArtist) {
    const titleGroup = extractGroup(bracketArtist.rest.replace(/^[-–—:]+/, '').trim(), '(', ')')
    const parsedTitle = parseTrackTitle(cleanTrackSegment(titleGroup?.value ?? bracketArtist.rest))
    if (parsedTitle.title) {
      return {
        artist: bracketArtist.value || '',
        title: parsedTitle.title,
        version: parsedTitle.version,
        year
      }
    }
  }

  const parent = parts[parts.length - 2] ? normalizeText(parts[parts.length - 2] ?? '') : ''
  const parentMatch = parseDashed(parent, year)
  if (parentMatch && normalizeText(raw).toLowerCase().startsWith(`${normalizeText(parentMatch.artist).toLowerCase()}-`)) {
    const parsedTitle = parseTrackTitle(cleanTrackSegment(raw.slice(parentMatch.artist.length + 1)))
    if (parsedTitle.title) return { artist: parentMatch.artist, title: parsedTitle.title, version: parsedTitle.version, year }
  }
  const loose = parseLooseDashed(raw, year)
  if (loose) return loose
  if (parentMatch) return parentMatch

  const titleGroup = extractGroup(raw, '(', ')')
  const parsedTitle = parseTrackTitle(cleanTrackSegment(titleGroup?.value ?? raw))
  return parsedTitle.title ? { artist: '', title: parsedTitle.title, version: parsedTitle.version, year } : null
}

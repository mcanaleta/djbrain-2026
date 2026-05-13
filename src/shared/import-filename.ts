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
  const artist = value.slice(0, separatorIndex).trim()
  const parsedTitle = parseTrackTitle(value.slice(separatorIndex + 3).trim())
  return artist && parsedTitle.title
    ? { artist, title: parsedTitle.title, version: parsedTitle.version, year }
    : null
}

export function parseImportFilename(filename: string): ParsedImportFilename | null {
  const normalizedPath = filename.replace(/\\/g, '/')
  const parts = normalizedPath.split('/').filter(Boolean)
  const basename = parts[parts.length - 1] ?? filename
  const year = normalizedPath.match(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/)?.[1] ?? null
  const raw = stripTrackPrefix(normalizeText(stripExtension(basename)))
  const direct = parseDashed(raw, year)
  if (direct) return direct

  const bracketArtist = extractGroup(raw, '[', ']')
  if (bracketArtist) {
    const titleGroup = extractGroup(bracketArtist.rest.replace(/^[-–—:]+/, '').trim(), '(', ')')
    const parsedTitle = parseTrackTitle((titleGroup?.value ?? bracketArtist.rest).trim())
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
  if (parentMatch) return parentMatch

  const titleGroup = extractGroup(raw, '(', ')')
  const parsedTitle = parseTrackTitle((titleGroup?.value ?? raw).trim())
  return parsedTitle.title ? { artist: '', title: parsedTitle.title, version: parsedTitle.version, year } : null
}

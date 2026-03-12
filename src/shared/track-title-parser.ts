export type ParsedTrackTitle = {
  title: string
  version: string | null
}

/**
 * Parses a track title, extracting the version from a trailing parenthetical
 * or bracketed expression.
 *
 * Examples:
 *   "Protec (Extended Version)" → { title: "Protec", version: "Extended Version" }
 *   "Shed (Original Mix)"       → { title: "Shed", version: "Original Mix" }
 *   "Track [Dub Mix]"           → { title: "Track", version: "Dub Mix" }
 *   "Track (feat. X) (Extended)"→ { title: "Track (feat. X)", version: "Extended" }
 *   "Simple Track"              → { title: "Simple Track", version: null }
 */
export function parseTrackTitle(raw: string): ParsedTrackTitle {
  const trimmed = raw.trim()

  // Match the last trailing parenthetical (...) or bracketed [...] expression.
  // The lazy (.*?) combined with the $ anchor ensures we capture the LAST such group.
  const match = trimmed.match(/^(.*?)\s*(?:\(([^)]+)\)|\[([^\]]+)\])\s*$/)
  if (!match) {
    return { title: trimmed, version: null }
  }

  const titlePart = match[1].trim()
  const versionPart = (match[2] ?? match[3] ?? '').trim()

  if (!titlePart || !versionPart) {
    return { title: trimmed, version: null }
  }

  return { title: titlePart, version: versionPart }
}

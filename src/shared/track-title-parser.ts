export type ParsedTrackTitle = {
  title: string
  version: string | null
}

const VERSION_HINT_RE =
  /\b(?:mix|edit|version|remix|rmx|dub|vocal|instrumental|radio|club|extended|original|rework|bootleg|vip|live|demo|take|cut|part|pt\.?|short|long|anthem|mixshow|remaster(?:ed)?|mono|stereo|acapella|a cappella)\b/i

function looksLikeVersion(value: string): boolean {
  return VERSION_HINT_RE.test(value.trim())
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
  const trimmed = raw.trim().replace(/^(?:[a-d]\d{0,2}|\d{1,2})\s*-\s+/i, '')

  const dashIndex = trimmed.lastIndexOf(' - ')
  if (dashIndex > 0) {
    const titlePart = trimmed.slice(0, dashIndex).trim()
    const versionPart = trimmed.slice(dashIndex + 3).trim()
    if (titlePart && versionPart && looksLikeVersion(versionPart)) {
      return { title: titlePart, version: versionPart }
    }
  }

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

  if (
    /^[a-d]$/i.test(versionPart) ||
    /^(?:19|20)\d{2}$/.test(versionPart) ||
    /\b(?:vol(?:ume)?|disc|cd)\b/i.test(versionPart)
  ) {
    const nested = parseTrackTitle(titlePart)
    return nested.title ? nested : { title: titlePart, version: null }
  }

  if (!looksLikeVersion(versionPart)) {
    return { title: trimmed, version: null }
  }

  return { title: titlePart, version: versionPart }
}

import { buildDiscogsEntityPath } from '../../../shared/discogs'
import type { OnlineSearchItem, OnlineSearchSource } from '../../../shared/online-search'

export const ONLINE_SOURCE_LABELS: Record<OnlineSearchSource, string> = {
  discogs: 'Discogs',
  beatport: 'Beatport',
  spotify: 'Spotify',
  applemusic: 'Apple Music',
  youtube: 'YouTube',
  unknown: 'Web'
}

export function getDiscogsRoute(item: OnlineSearchItem): string | null {
  if (item.source !== 'discogs') {
    return null
  }

  const match = item.link.match(/discogs\.com\/(?:[^/]+\/)?(release|artist|label|master)\/(\d+)/i)
  if (!match) {
    return null
  }

  return buildDiscogsEntityPath(
    match[1].toLowerCase() as 'release' | 'artist' | 'label' | 'master',
    match[2]
  )
}

export function summarizeOnlineResult(item: OnlineSearchItem): string {
  if (item.candidates.length > 0) {
    return item.candidates
      .slice(0, 2)
      .map((candidate) => {
        const artist = candidate.artist ?? candidate.artists?.join(', ') ?? 'Unknown artist'
        const version = candidate.version ? ` (${candidate.version})` : ''
        const year = candidate.year ? ` · ${candidate.year}` : ''
        return `${artist} - ${candidate.title}${version}${year}`
      })
      .join(' | ')
  }

  return item.snippet || item.displayLink || item.link
}

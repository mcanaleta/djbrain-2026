import type { AppSettings } from './settings-store.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { DiscogsRelease } from '../shared/discogs.ts'
import type { DiscogsTrackSearchResult } from '../shared/api.ts'
import { parseTrackTitle } from '../shared/track-title-parser.ts'
import { parseDurationString, rankCandidates, type MatchCandidate } from '../shared/track-matcher.ts'

const MIN_VIDEO_SCORE = 30

function releaseFormat(release: DiscogsRelease): string | null {
  return release.formats[0] ?? null
}

function youtubeId(uri: string): string | null {
  const match = uri.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^&?/]+)/i)
  return match?.[1] ?? null
}

function videoCandidates(release: DiscogsRelease): MatchCandidate[] {
  return release.videos.flatMap((video) => {
    const id = youtubeId(video.uri)
    return id ? [{ id, title: video.title || video.uri, duration: video.duration }] : []
  })
}

export function buildDiscogsTrackSearchResults(releases: DiscogsRelease[]): DiscogsTrackSearchResult[] {
  return releases.flatMap((release) =>
    release.tracklist.map((track) => {
      const parsed = parseTrackTitle(track.title)
      const artist = track.artists?.join(', ') || release.artists.join(', ')
      const durationSeconds = track.duration ? parseDurationString(track.duration) : null
      const video = rankCandidates(
        { artist, title: track.title, durationSeconds: durationSeconds ?? undefined },
        videoCandidates(release)
      ).find((item) => item.score >= MIN_VIDEO_SCORE)
      return {
        releaseId: release.id,
        releaseTitle: release.title,
        format: releaseFormat(release),
        artist,
        title: parsed.title || track.title,
        version: parsed.version,
        trackPosition: track.position ?? null,
        year: release.year ?? null,
        label: release.labels[0] ?? null,
        catalogNumber: release.catalogNumbers[0] ?? null,
        durationSeconds,
        score: 0,
        externalUrl: release.externalUrl,
        youtubeVideoId: video?.id ?? null,
        youtubeTitle: video?.title ?? null
      }
    })
  )
}

export async function searchDiscogsTracks(settings: AppSettings, query: string, onlineSearch: OnlineSearchService): Promise<DiscogsTrackSearchResult[]> {
  const releases = []
  for (const result of (await onlineSearch.searchDiscogsReleases(settings, query)).slice(0, 8)) {
    if (result.type !== 'release' || !result.id) continue
    const entity = await onlineSearch.getDiscogsEntity(settings, 'release', result.id)
    if (entity.type === 'release') releases.push(entity)
  }
  return buildDiscogsTrackSearchResults(releases).slice(0, 80)
}

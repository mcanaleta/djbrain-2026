import type { CollectionItemDetails, RecordingDetails } from './api.ts'
import type { DiscogsTrack } from './discogs.ts'
import { parseDurationString } from './track-matcher.ts'

function norm(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function duration(track: DiscogsTrack): number | null {
  return track.duration ? parseDurationString(track.duration) : null
}

export function findDiscogsDisplayTrack(
  tracks: DiscogsTrack[],
  position: string | null | undefined,
  title: string | null | undefined,
  referenceSeconds?: number | null
): DiscogsTrack | null {
  return tracks.find((track) => norm(track.position) === norm(position))
    ?? tracks.find((track) => norm(track.title) === norm(title))
    ?? tracks.find((track) => {
      const seconds = duration(track)
      return seconds != null && referenceSeconds != null && Math.abs(seconds - referenceSeconds) < 1
    })
    ?? null
}

export function buildCollectionItemHeading(
  item: CollectionItemDetails | null | undefined,
  recording: RecordingDetails | null | undefined,
  discogsTrack: DiscogsTrack | null | undefined
): { title: string; subtitle: string } {
  const canonical = recording?.canonical ?? item?.recordingCanonical ?? null
  const artist = canonical?.artist || item?.tags?.artist || 'Unknown artist'
  const title = discogsTrack?.title || canonical?.title || item?.tags?.title || 'Unknown title'
  const version = !discogsTrack && canonical?.version ? ` (${canonical.version})` : ''
  const year = canonical?.year || item?.tags?.year || null
  return {
    title: `${artist} · ${title}${version}${year ? ` (${year})` : ''}`,
    subtitle: item?.filename ?? 'Collection item'
  }
}

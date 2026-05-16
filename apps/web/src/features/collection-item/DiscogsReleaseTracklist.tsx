import type { DiscogsTrack } from '@djbrain/shared/discogs'
import { parseDurationString } from '@djbrain/shared/track-matcher'
import { Pill } from '../../components/view/Pill'
import { formatCompactDuration } from '../../lib/music-file'

function norm(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function assigned(track: DiscogsTrack, position: string | null, title: string | null): boolean {
  return Boolean((position && norm(track.position) === norm(position)) || (!position && title && norm(track.title) === norm(title)))
}

export function DiscogsReleaseTracklist({
  tracks,
  assignedPosition,
  assignedTitle
}: {
  tracks: DiscogsTrack[]
  assignedPosition: string | null
  assignedTitle: string | null
}): React.JSX.Element | null {
  if (tracks.length === 0) return null
  return (
    <div className="mt-3 overflow-hidden rounded border border-zinc-800">
      <table className="w-full text-xs">
        <thead className="bg-zinc-950 text-left uppercase text-zinc-500">
          <tr>
            <th className="w-[56px] px-2 py-1.5 font-medium">Pos</th>
            <th className="px-2 py-1.5 font-medium">Track</th>
            <th className="w-[80px] px-2 py-1.5 text-right font-medium">Len</th>
            <th className="w-[76px] px-2 py-1.5 text-right font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track, index) => {
            const isAssigned = assigned(track, assignedPosition, assignedTitle)
            return (
              <tr key={`${track.position ?? index}-${track.title}`} className={`border-t border-zinc-800/70 ${isAssigned ? 'bg-sky-950/30' : ''}`}>
                <td className="px-2 py-1.5 text-zinc-500">{track.position || '-'}</td>
                <td className="px-2 py-1.5 text-zinc-100">
                  {track.artists?.length ? <span className="text-zinc-400">{track.artists.join(', ')} - </span> : null}
                  {track.title}
                </td>
                <td className="px-2 py-1.5 text-right text-zinc-400">{formatCompactDuration(track.duration ? parseDurationString(track.duration) : null)}</td>
                <td className="px-2 py-1.5 text-right">{isAssigned ? <Pill tone="primary">Assigned</Pill> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

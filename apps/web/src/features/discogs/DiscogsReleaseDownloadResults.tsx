import type { DiscogsReleaseDownloadResult } from '@djbrain/shared/api'
import { fileBasename } from '../../lib/music-file'

const STATUS_LABELS = {
  verified: 'VERIFIED',
  no_results: 'NO RESULTS',
  download_error: 'DOWNLOAD ERROR',
  identify_error: 'IDENTIFY ERROR'
} as const

export function DiscogsReleaseDownloadResults({
  result
}: {
  result: DiscogsReleaseDownloadResult
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="text-sm text-zinc-300">
        Verified {result.verifiedCount}/{result.trackCount} tracks.
      </div>
      <table className="min-w-full text-sm">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="w-[1%] whitespace-nowrap px-2 py-1">Status</th>
            <th className="px-2 py-1">Track</th>
            <th className="px-2 py-1">File</th>
            <th className="w-[1%] whitespace-nowrap px-2 py-1">Record</th>
          </tr>
        </thead>
        <tbody>
          {result.results.map((track, index) => (
            <tr key={`${track.position ?? index}-${track.title}`} className="border-t border-zinc-800">
              <td className="px-2 py-1 align-top">
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-200">
                  {STATUS_LABELS[track.status]}
                </span>
              </td>
              <td className="px-2 py-1 text-zinc-200">
                {track.position ? `${track.position} ` : ''}
                {track.artist} - {track.title}
                {track.version ? ` (${track.version})` : ''}
              </td>
              <td className="px-2 py-1 text-zinc-400">{track.filename ? fileBasename(track.filename) : track.message ?? '—'}</td>
              <td className="px-2 py-1 text-zinc-400">{track.recordingId ? `#${track.recordingId}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

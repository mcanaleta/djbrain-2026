import type { RecordingDetails } from '../../../../shared/api'
import { ViewSection } from '../../components/view/ViewSection'
import { buildDiscogsReleaseUrl } from '../../lib/urls'
import { formatCompactDuration } from '../../lib/music-file'

function readDiscogsReleaseId(externalKey: string): string | null {
  const match = externalKey.match(/^discogs:release:(\d+)/i)
  return match ? match[1] : null
}

export function ImportRecordDiscogsReleases({ recording }: { recording: RecordingDetails }): React.JSX.Element | null {
  const rows = [...new Map(
    recording.sourceClaims
      .filter((claim) => claim.provider === 'discogs')
      .map((claim) => {
        const releaseId = readDiscogsReleaseId(claim.externalKey)
        const key = releaseId ?? claim.externalKey
        return [
          key,
          {
            key,
            releaseId,
            releaseTitle: claim.releaseTitle ?? '—',
            trackPosition: claim.trackPosition ?? '—',
            title: [claim.artist, claim.title].filter(Boolean).join(' - ') || '—',
            year: claim.year ?? '—',
            length: formatCompactDuration(claim.durationSeconds)
          }
        ] as const
      })
  ).values()]

  if (!rows.length) return null

  return (
    <ViewSection title="Discogs Releases" borderless className="p-0" bodyClassName="mt-0">
      <div className="overflow-x-auto rounded-none border-y border-zinc-800">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-zinc-950/50 text-zinc-500">
            <tr>
              <th className="px-2 py-1.5 font-medium">Release</th>
              <th className="px-2 py-1.5 font-medium">Track</th>
              <th className="px-2 py-1.5 font-medium">Match</th>
              <th className="px-2 py-1.5 font-medium">Year</th>
              <th className="px-2 py-1.5 font-medium">Len</th>
              <th className="w-[1%] whitespace-nowrap px-2 py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-zinc-800">
                <td className="px-2 py-1.5 text-zinc-100">{row.releaseTitle}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-zinc-300">{row.trackPosition}</td>
                <td className="px-2 py-1.5 text-zinc-100">{row.title}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-zinc-300">{row.year}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-zinc-300">{row.length}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {row.releaseId ? (
                    <a className="text-zinc-400 hover:text-zinc-100" href={buildDiscogsReleaseUrl(row.releaseId)} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ViewSection>
  )
}

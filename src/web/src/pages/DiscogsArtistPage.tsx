import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Notice } from '../components/view'
import { RelatedLinks } from './discogs-shared'

export default function DiscogsArtistPage(): React.JSX.Element {
  const { discogsId } = useParams<{ discogsId: string }>()
  const id = Number(discogsId)

  const { data: artist, isLoading, error } = useQuery({
    queryKey: ['discogs', 'artist', id],
    queryFn: () => api.onlineSearch.getDiscogsEntity('artist', id),
    enabled: Number.isInteger(id) && id > 0
  })

  const errorMsg = error instanceof Error ? error.message : null

  return (
    <div className="space-y-4">
      {errorMsg ? <Notice tone="error" className="text-sm">{errorMsg}</Notice> : null}
      {isLoading ? <Notice className="text-sm">Loading…</Notice> : null}
      {artist ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="text-base font-semibold text-zinc-100">{artist.name}</div>
            <a href={artist.externalUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300">↗ Discogs</a>
          </div>
          <div className="flex gap-4">
            {artist.heroImageUrl ? (
              <img src={artist.heroImageUrl} alt={artist.name} className="h-32 w-32 shrink-0 rounded border border-zinc-800 object-cover" />
            ) : null}
            <table className="text-sm">
              <tbody>
                {artist.realName && <tr><td className="pr-4 text-zinc-500">Real Name</td><td className="text-zinc-200">{artist.realName}</td></tr>}
                {artist.nameVariations.length > 0 && <tr><td className="pr-4 text-zinc-500">Also Known As</td><td className="text-zinc-200">{artist.nameVariations.join(', ')}</td></tr>}
              </tbody>
            </table>
          </div>
          {artist.profile ? <p className="text-sm leading-6 text-zinc-400">{artist.profile}</p> : null}
          <RelatedLinks title="Aliases" items={artist.aliases} />
          <RelatedLinks title="Members" items={artist.members} />
          <RelatedLinks title="Groups" items={artist.groups} />
        </>
      ) : null}
    </div>
  )
}

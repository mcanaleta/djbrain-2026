import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Notice } from '../components/view/Notice'
import { Tracklist, VideoSection, RelatedLinks, useTrackWantList } from './discogs-shared'

export default function DiscogsMasterPage(): React.JSX.Element {
  const { discogsId } = useParams<{ discogsId: string }>()
  const id = Number(discogsId)

  const { data: master, isLoading, error } = useQuery({
    queryKey: ['discogs', 'master', id],
    queryFn: () => api.onlineSearch.getDiscogsEntity('master', id),
    enabled: Number.isInteger(id) && id > 0
  })

  const { data: collectionItems = [] } = useQuery({
    queryKey: ['collection'],
    queryFn: async () => (await api.collection.list()).items,
    staleTime: 60_000
  })

  const { data: downloadItems = [] } = useQuery({
    queryKey: ['collection-downloads'],
    queryFn: async () => (await api.collection.listDownloads()).items,
    staleTime: 60_000
  })

  const [wantError, setWantError] = useState<string | null>(null)
  const masterSource = master ? { ...master, discogsEntityId: master.id, discogsEntityType: 'master' } : null
  const { addedTrackIndices, handleAddToWantList } = useTrackWantList(masterSource, setWantError)
  const errorMsg = wantError ?? (error instanceof Error ? error.message : null)

  return (
    <div className="space-y-4">
      {errorMsg ? <Notice tone="error" className="text-sm">{errorMsg}</Notice> : null}
      {isLoading ? <Notice className="text-sm">Loading…</Notice> : null}
      {master ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="text-base font-semibold text-zinc-100">{master.artists.join(', ')} – {master.title}</div>
            <a href={master.externalUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300">↗ Discogs</a>
          </div>
          <div className="flex gap-4">
            {master.heroImageUrl ? (
              <img src={master.heroImageUrl} alt={master.title} className="h-32 w-32 shrink-0 rounded border border-zinc-800 object-cover" />
            ) : null}
            <table className="text-sm">
              <tbody>
                {master.year && <tr><td className="pr-4 text-zinc-500">Year</td><td className="text-zinc-200">{master.year}</td></tr>}
                {master.genres.length > 0 && <tr><td className="pr-4 text-zinc-500">Genre</td><td className="text-zinc-200">{master.genres.join(', ')}</td></tr>}
                {master.styles.length > 0 && <tr><td className="pr-4 text-zinc-500">Style</td><td className="text-zinc-200">{master.styles.join(', ')}</td></tr>}
              </tbody>
            </table>
          </div>
          <Tracklist
            tracklist={master.tracklist}
            artists={master.artists}
            videos={master.videos}
            collectionItems={collectionItems}
            downloadItems={downloadItems}
            addedTrackIndices={addedTrackIndices}
            onAdd={handleAddToWantList}
          />
          <VideoSection videos={master.videos} />
          <RelatedLinks title="Artists" items={master.relatedArtists} />
          {master.mainRelease ? <RelatedLinks title="Main Release" items={[master.mainRelease]} /> : null}
        </>
      ) : null}
    </div>
  )
}

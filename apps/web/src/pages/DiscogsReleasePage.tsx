import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Notice } from '../components/view/Notice'
import { Tracklist, VideoSection, RelatedLinks, useTrackWantList } from './discogs-shared'

export default function DiscogsReleasePage(): React.JSX.Element {
  const { discogsId } = useParams<{ discogsId: string }>()
  const id = Number(discogsId)

  const { data: release, isLoading, error } = useQuery({
    queryKey: ['discogs', 'release', id],
    queryFn: () => api.onlineSearch.getDiscogsEntity('release', id),
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
  const releaseSource = release ? { ...release, discogsEntityId: release.id, discogsEntityType: 'release' } : null
  const { addedTrackIndices, handleAddToWantList } = useTrackWantList(releaseSource, setWantError)
  const errorMsg = wantError ?? (error instanceof Error ? error.message : null)

  return (
    <div className="space-y-4">
      {errorMsg ? <Notice tone="error" className="text-sm">{errorMsg}</Notice> : null}
      {isLoading ? <Notice className="text-sm">Loading…</Notice> : null}
      {release ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="text-base font-semibold text-zinc-100">{release.artists.join(', ')} – {release.title}</div>
            <a href={release.externalUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300">↗ Discogs</a>
          </div>
          <div className="flex gap-4">
            {release.heroImageUrl ? (
              <img src={release.heroImageUrl} alt={release.title} className="h-32 w-32 shrink-0 rounded border border-zinc-800 object-cover" />
            ) : null}
            <table className="text-sm">
              <tbody>
                {release.labels.length > 0 && <tr><td className="pr-4 text-zinc-500">Label</td><td className="text-zinc-200">{[release.labels[0], release.catalogNumbers[0]].filter(Boolean).join(' – ')}</td></tr>}
                {release.formats.length > 0 && <tr><td className="pr-4 text-zinc-500">Format</td><td className="text-zinc-200">{release.formats.join(', ')}</td></tr>}
                {release.country && <tr><td className="pr-4 text-zinc-500">Country</td><td className="text-zinc-200">{release.country}</td></tr>}
                {release.year && <tr><td className="pr-4 text-zinc-500">Released</td><td className="text-zinc-200">{release.year}</td></tr>}
                {release.genres.length > 0 && <tr><td className="pr-4 text-zinc-500">Genre</td><td className="text-zinc-200">{release.genres.join(', ')}</td></tr>}
                {release.styles.length > 0 && <tr><td className="pr-4 text-zinc-500">Style</td><td className="text-zinc-200">{release.styles.join(', ')}</td></tr>}
              </tbody>
            </table>
          </div>
          <Tracklist
            tracklist={release.tracklist}
            artists={release.artists}
            videos={release.videos}
            collectionItems={collectionItems}
            downloadItems={downloadItems}
            addedTrackIndices={addedTrackIndices}
            onAdd={handleAddToWantList}
          />
          <VideoSection videos={release.videos} />
          <RelatedLinks title="Artists" items={release.relatedArtists} />
          <RelatedLinks title="Labels" items={release.relatedLabels} />
        </>
      ) : null}
    </div>
  )
}

import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Notice } from '../components/view'
import { RelatedLinks } from './discogs-shared'

export default function DiscogsLabelPage(): React.JSX.Element {
  const { discogsId } = useParams<{ discogsId: string }>()
  const id = Number(discogsId)

  const { data: label, isLoading, error } = useQuery({
    queryKey: ['discogs', 'label', id],
    queryFn: () => window.api.onlineSearch.getDiscogsEntity('label', id),
    enabled: Number.isInteger(id) && id > 0
  })

  const errorMsg = error instanceof Error ? error.message : null

  return (
    <div className="space-y-4">
      {errorMsg ? <Notice tone="error" className="text-sm">{errorMsg}</Notice> : null}
      {isLoading ? <Notice className="text-sm">Loading…</Notice> : null}
      {label ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="text-base font-semibold text-zinc-100">{label.name}</div>
            <a href={label.externalUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300">↗ Discogs</a>
          </div>
          <div className="flex gap-4">
            {label.heroImageUrl ? (
              <img src={label.heroImageUrl} alt={label.name} className="h-32 w-32 shrink-0 rounded border border-zinc-800 object-cover" />
            ) : null}
            {label.contactInfo ? (
              <table className="text-sm">
                <tbody>
                  <tr><td className="pr-4 text-zinc-500">Contact</td><td className="text-zinc-200">{label.contactInfo}</td></tr>
                </tbody>
              </table>
            ) : null}
          </div>
          {label.profile ? <p className="text-sm leading-6 text-zinc-400">{label.profile}</p> : null}
          {label.parentLabel ? <RelatedLinks title="Parent Label" items={[label.parentLabel]} /> : null}
          <RelatedLinks title="Sublabels" items={label.sublabels} />
        </>
      ) : null}
    </div>
  )
}

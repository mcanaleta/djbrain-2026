import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { IdentifyEvidenceTable } from '../features/identify/IdentifyEvidenceTable'
import { buildIdentifyHref, buildIdentifyReviewHref } from '../lib/urls'

const readFilter = (value: string | null): 'all' | 'verified' | 'unverified' =>
  value === 'all' || value === 'verified' ? value : 'unverified'

export default function IdentifyItemPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { itemId = '' } = useParams<{ itemId: string }>()
  const [params] = useSearchParams()
  const scope = params.get('scope') === 'collection' ? 'collection' : 'downloads'
  const query = params.get('query') ?? ''
  const filter = readFilter(params.get('filter'))
  const id = Number(itemId)

  return (
    <IdentifyEvidenceTable
      itemId={id}
      scope={scope}
      query={query}
      filter={filter}
      onBack={() => navigate(buildIdentifyHref(scope, query, filter))}
      onOpenItem={(nextId) => navigate(buildIdentifyReviewHref(nextId, scope, query, filter))}
    />
  )
}

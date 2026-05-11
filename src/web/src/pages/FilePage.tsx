import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { IdentifyEvidenceTable } from '../features/identify/IdentifyEvidenceTable'
import { buildFileHref, buildIdentifyHref } from '../lib/urls'

const readFilter = (value: string | null): 'all' | 'verified' | 'unverified' =>
  value === 'all' || value === 'verified' ? value : 'unverified'

export default function FilePage(): React.JSX.Element {
  const navigate = useNavigate()
  const { itemId = '' } = useParams<{ itemId: string }>()
  const [params] = useSearchParams()
  const scopeParam = params.get('scope')
  const scope = scopeParam === 'downloads' ? 'downloads' : 'collection'
  const query = params.get('query') ?? ''
  const filter = readFilter(params.get('filter'))

  return (
    <IdentifyEvidenceTable
      itemId={Number(itemId)}
      scope={scope}
      query={query}
      filter={filter}
      onBack={() => navigate(scopeParam ? buildIdentifyHref(scope, query, filter) : '/collection')}
      onOpenItem={(nextId) => navigate(buildFileHref(nextId, scope, query, filter))}
    />
  )
}

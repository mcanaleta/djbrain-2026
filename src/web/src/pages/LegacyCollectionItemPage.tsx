import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { Notice } from '../components/view/Notice'
import { buildCollectionItemHref } from '../lib/urls'

export default function LegacyCollectionItemPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const filename = (params.get('filename') ?? '').trim()
  const { data: item, error, isPending } = useQuery({
    queryKey: ['collection', 'item', 'legacy', filename],
    queryFn: () => api.collection.get(filename),
    enabled: Boolean(filename)
  })

  useEffect(() => {
    if (item) navigate(buildCollectionItemHref(item.id), { replace: true })
  }, [item, navigate])

  if (!filename) return <Navigate to="/collection" replace />
  if (isPending) return <Notice className="text-sm">Opening item…</Notice>
  if (error) return <Notice tone="error" className="text-sm">{error instanceof Error ? error.message : 'Failed to open item.'}</Notice>
  if (!item) return <Notice tone="warning" className="text-sm">Item not found in collection.</Notice>
  return <Notice className="text-sm">Opening item…</Notice>
}

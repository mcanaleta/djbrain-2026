import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { ImportReviewDialog } from '../components/ImportReviewDialog'
import { buildImportHref, buildImportReviewHref } from '../lib/urls'

export default function ImportReviewPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { itemId } = useParams<{ itemId: string }>()
  const id = Number(itemId)
  const [searchParams] = useSearchParams()
  const query = searchParams.get('query') ?? ''
  const { data: item } = useQuery({
    queryKey: ['collection', 'item', id],
    queryFn: () => api.collection.getById(id),
    enabled: Number.isInteger(id) && id > 0
  })
  const { data: listResult } = useQuery({
    queryKey: ['collection', 'downloads', query],
    queryFn: () => api.collection.listDownloads(query)
  })
  const items = listResult?.items ?? []
  const currentIndex = useMemo(
    () => items.findIndex((entry) => entry.id === id),
    [id, items]
  )
  const currentItem = currentIndex >= 0 ? items[currentIndex] ?? null : null
  const nextItemId = currentIndex >= 0 ? items[currentIndex + 1]?.id ?? null : null
  const importHref = buildImportHref(query)
  const nextHref = nextItemId != null ? buildImportReviewHref(nextItemId, query) : importHref

  const handleResolved = (): void => {
    navigate(nextHref, { replace: true })
  }

  return (
    <div>
      <ImportReviewDialog
        filename={item?.filename ?? null}
        currentItem={currentItem}
        queuePosition={currentIndex >= 0 ? currentIndex + 1 : null}
        queueTotal={items.length || null}
        onClose={() => navigate(importHref)}
        onCommitted={handleResolved}
        onDeleted={handleResolved}
      />
    </div>
  )
}

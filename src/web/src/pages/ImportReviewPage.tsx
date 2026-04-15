import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { CollectionItem } from '../../../shared/api'
import { api } from '../api/client'
import { ImportReviewDialog } from '../components/ImportReviewDialog'

export default function ImportReviewPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const filename = searchParams.get('filename')
  const query = searchParams.get('query') ?? ''
  const [items, setItems] = useState<CollectionItem[]>([])

  useEffect(() => {
    let active = true
    void api.collection.listDownloads(query).then((result) => {
      if (active) setItems(result.items)
    }).catch(() => {
      if (active) setItems([])
    })
    return () => {
      active = false
    }
  }, [query, filename])

  const currentIndex = useMemo(
    () => (filename ? items.findIndex((item) => item.filename === filename) : -1),
    [filename, items]
  )
  const currentItem = currentIndex >= 0 ? items[currentIndex] ?? null : null
  const nextFilename = currentIndex >= 0 ? items[currentIndex + 1]?.filename ?? null : null

  const importHref = query ? `/import?query=${encodeURIComponent(query)}` : '/import'
  const nextHref = nextFilename
    ? `/import/review?filename=${encodeURIComponent(nextFilename)}${query ? `&query=${encodeURIComponent(query)}` : ''}`
    : importHref

  const handleResolved = (): void => {
    navigate(nextHref, { replace: true })
  }

  return (
    <div>
      <ImportReviewDialog
        filename={filename}
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

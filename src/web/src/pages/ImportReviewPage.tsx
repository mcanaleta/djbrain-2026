import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { ImportReviewDialog } from '../components/ImportReviewDialog'
import { buildImportHref, buildImportReviewHref } from '../lib/urls'

export default function ImportReviewPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const filename = searchParams.get('filename')
  const query = searchParams.get('query') ?? ''
  const { data: listResult } = useQuery({
    queryKey: ['collection', 'downloads', query],
    queryFn: () => api.collection.listDownloads(query)
  })
  const items = listResult?.items ?? []

  const currentIndex = useMemo(
    () => (filename ? items.findIndex((item) => item.filename === filename) : -1),
    [filename, items]
  )
  const currentItem = currentIndex >= 0 ? items[currentIndex] ?? null : null
  const nextFilename = currentIndex >= 0 ? items[currentIndex + 1]?.filename ?? null : null

  const importHref = buildImportHref(query)
  const nextHref = nextFilename ? buildImportReviewHref(nextFilename, query) : importHref

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

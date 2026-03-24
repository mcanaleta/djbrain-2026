import { useNavigate, useSearchParams } from 'react-router-dom'
import { ImportReviewDialog } from '../components/ImportReviewDialog'

export default function ImportReviewPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const filename = searchParams.get('filename')

  return (
    <ImportReviewDialog
      filename={filename}
      onClose={() => navigate('/import')}
      onCommitted={() => navigate('/import')}
    />
  )
}

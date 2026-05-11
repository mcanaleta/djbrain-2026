import { Navigate, useLocation, useParams } from 'react-router-dom'
import { buildFileHref } from '../lib/urls'

export default function IdentifyItemPage(): React.JSX.Element {
  const { itemId = '' } = useParams<{ itemId: string }>()
  const { search } = useLocation()
  return <Navigate to={`${buildFileHref(itemId)}${search}`} replace />
}

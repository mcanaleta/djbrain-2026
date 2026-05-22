import { Pill } from '../../components/view/Pill'
import { WANT_LIST_STATUS_CLASS, WANT_LIST_STATUS_LABEL, type WantListPipelineStatus } from './view-model'

const BUSY_STATUSES: WantListPipelineStatus[] = ['searching', 'downloading', 'identifying', 'importing']

export function WantListStatusBadge({ status }: { status: WantListPipelineStatus }): React.JSX.Element {
  return (
    <Pill className={WANT_LIST_STATUS_CLASS[status]} pulse={BUSY_STATUSES.includes(status)}>
      {WANT_LIST_STATUS_LABEL[status]}
    </Pill>
  )
}

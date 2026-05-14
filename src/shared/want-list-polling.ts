import type { WantListPipelineStatus } from './api.ts'

const POLL_STATUSES = new Set<WantListPipelineStatus>(['queued', 'searching', 'downloading'])

export function shouldPollWantListItem(status: WantListPipelineStatus | null | undefined): boolean {
  return Boolean(status && POLL_STATUSES.has(status))
}

import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { RuntimeProcessState, RuntimeProcessStatus } from '@djbrain/shared/runtime-status'
import { api } from '../api/client'
import { Badge } from '../components/view/Badge'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { MiniStat } from '../components/view/MiniStat'
import { Notice } from '../components/view/Notice'
import { PageHero } from '../components/view/PageHero'
import { ViewSection } from '../components/view/ViewSection'
import { getErrorMessage } from '../lib/error-utils'

const stateClass: Record<RuntimeProcessState, string> = {
  active: 'bg-sky-600 text-white',
  stale: 'bg-amber-500 text-zinc-950',
  missing: 'bg-zinc-700 text-zinc-100'
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '-'
}

function expiryLabel(row: RuntimeProcessStatus): string {
  if (row.secondsUntilExpiry == null) return '-'
  if (row.secondsUntilExpiry > 0) return `${row.secondsUntilExpiry}s`
  return `${Math.abs(row.secondsUntilExpiry)}s stale`
}

const columns: DataTableColumn<RuntimeProcessStatus>[] = [
  {
    key: 'role',
    header: 'Role',
    cellClassName: 'w-[1%] whitespace-nowrap',
    render: (row) => <span className="font-medium text-zinc-100">{row.role}</span>
  },
  {
    key: 'state',
    header: 'State',
    cellClassName: 'w-[1%] whitespace-nowrap',
    render: (row) => <Badge label={row.state} className={stateClass[row.state]} />
  },
  { key: 'owner', header: 'Owner', render: (row) => row.ownerId ?? '-' },
  { key: 'host', header: 'Host', render: (row) => [row.hostname, row.pid].filter(Boolean).join(':') || '-' },
  { key: 'priority', header: 'Prio', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => row.priority ?? '-' },
  { key: 'expires', header: 'Expires', cellClassName: 'w-[1%] whitespace-nowrap', render: expiryLabel },
  { key: 'heartbeat', header: 'Heartbeat', cellClassName: 'whitespace-nowrap', render: (row) => formatDate(row.heartbeatAt) },
  {
    key: 'cmd',
    header: 'Local takeover',
    cellClassName: 'min-w-[340px]',
    render: (row) => <code className="rounded bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-300">{row.takeoverCommand}</code>
  },
  {
    key: 'db',
    header: '',
    cellClassName: 'w-[1%] whitespace-nowrap',
    render: (row) => <Link className="text-[10px] text-sky-300 hover:text-sky-200" to={row.databaseHref}>DB</Link>
  }
]

export default function RuntimePage(): React.JSX.Element {
  const { data, error, isPending } = useQuery({
    queryKey: ['runtime', 'status'],
    queryFn: api.runtime.getStatus,
    refetchInterval: 5000
  })
  const errorMessage = error ? getErrorMessage(error, 'Failed to load runtime status') : null

  return (
    <div className="space-y-3">
      <PageHero title="Runtime" subtitle="Schema and daemon ownership." />
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <MiniStat label="Code schema" value={data?.codeSchemaVersion ?? '-'} />
        <MiniStat label="DB schema" value={data?.databaseSchemaVersion ?? '-'} />
        <MiniStat label="Automation" value={data?.server.automationEnabled ? 'on' : 'off'} />
        <MiniStat label="Server workers" value={data?.server.serverBackgroundWorkersEnabled ? 'on' : 'off'} />
        <MiniStat label="Startup sync" value={data?.server.serverStartupSyncEnabled ? 'on' : 'off'} />
      </div>
      <ViewSection title="Processes" subtitle="Downloader, sync, and admin leases refresh every 5 seconds." padding="sm">
        <DataTable
          columns={columns}
          rows={data?.processes ?? []}
          getRowKey={(row) => row.role}
          loading={isPending}
          loadingMessage="Loading runtime status..."
          emptyMessage="No process roles."
          tableClassName="min-w-max"
        />
      </ViewSection>
    </div>
  )
}

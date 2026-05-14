import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { DatabaseTableSummary } from '../../../shared/database-inspector'
import { api } from '../api/client'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { Notice } from '../components/view/Notice'
import { PageHero } from '../components/view/PageHero'
import { ViewSection } from '../components/view/ViewSection'
import { dbHref } from '../features/database/database-view'
import { getErrorMessage } from '../lib/error-utils'

const columns: DataTableColumn<DatabaseTableSummary>[] = [
  { key: 'name', header: 'Table', render: (row) => <span className="font-medium text-zinc-100">{row.name}</span> },
  { key: 'rows', header: 'Rows', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => row.rowCount.toLocaleString() },
  { key: 'cols', header: 'Columns', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => row.columns.length },
  { key: 'pk', header: 'Primary Key', render: (row) => row.primaryKey.join(', ') || '—' }
]

export default function DatabaseTablesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { data = [], error, isPending } = useQuery({
    queryKey: ['database', 'tables'],
    queryFn: api.database.listTables
  })
  const errorMessage = error ? getErrorMessage(error, 'Failed to load database tables') : null

  return (
    <div className="space-y-3">
      <PageHero title="Database" subtitle="Read-only Postgres explorer." />
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      <ViewSection title="Tables" subtitle={`${data.length} public tables`} padding="sm">
        <DataTable
          columns={columns}
          rows={data}
          getRowKey={(row) => row.name}
          onRowClick={(row) => navigate(dbHref(row.name))}
          loading={isPending}
          loadingMessage="Loading tables..."
        />
      </ViewSection>
    </div>
  )
}

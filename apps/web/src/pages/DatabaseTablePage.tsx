import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { Notice } from '../components/view/Notice'
import { PageHero } from '../components/view/PageHero'
import { QueryBar } from '../components/view/QueryBar'
import { ViewSection } from '../components/view/ViewSection'
import { DatabaseRowsTable, dbHref } from '../features/database/database-view'
import { getErrorMessage } from '../lib/error-utils'

export default function DatabaseTablePage(): React.JSX.Element {
  const navigate = useNavigate()
  const { table = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const filter = params.get('filter') ?? ''
  const [draft, setDraft] = useState(filter)
  useEffect(() => setDraft(filter), [filter])
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: ['database', 'table', table, filter],
    queryFn: () => api.database.listRows(table, { filter, limit: 75 }),
    enabled: Boolean(table)
  })
  const errorMessage = error ? getErrorMessage(error, 'Failed to load table rows') : null

  return (
    <div className="space-y-3">
      <PageHero title={table || 'Table'} subtitle="Rows are read-only. Open a row for fields and links." />
      <Link to="/database" className="text-xs text-zinc-400 hover:text-zinc-100">&lt;- Tables</Link>
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      <ViewSection
        title={data?.table.name ?? table}
        subtitle={data ? `${data.table.rowCount.toLocaleString()} rows / showing ${data.rows.length}` : 'Loading...'}
        padding="sm"
      >
        <QueryBar
          label="Filter"
          value={draft}
          onChange={setDraft}
          onSubmit={() => setParams(draft ? { filter: draft } : {}, { replace: true })}
          isBusy={isFetching}
          busyLabel="Filtering..."
        />
        <div className="mt-3">
          <DatabaseRowsTable
            table={table}
            columns={data?.table.columns ?? []}
            rows={data?.rows ?? []}
            loading={isPending}
            onRowClick={(row) => navigate(dbHref(table, row.key))}
          />
        </div>
      </ViewSection>
    </div>
  )
}

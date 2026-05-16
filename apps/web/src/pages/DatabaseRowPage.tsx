import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { Notice } from '../components/view/Notice'
import { PageHero } from '../components/view/PageHero'
import { Pill } from '../components/view/Pill'
import { ViewSection } from '../components/view/ViewSection'
import { ActionLinks, dbHref, formatDbValue } from '../features/database/database-view'
import { getErrorMessage } from '../lib/error-utils'
import type { DatabaseCellValue } from '@djbrain/shared/database-inspector'

type FieldRow = {
  name: string
  type: string
  flags: string[]
}

export default function DatabaseRowPage(): React.JSX.Element {
  const { table = '', key = '' } = useParams()
  const { data, error, isPending } = useQuery({
    queryKey: ['database', 'row', table, key],
    queryFn: () => api.database.getRow(table, key),
    enabled: Boolean(table && key)
  })
  const errorMessage = error ? getErrorMessage(error, 'Failed to load row') : null
  const rows: FieldRow[] = (data?.table.columns ?? []).map((column) => ({
    name: column.name,
    type: column.dataType,
    flags: [column.isPrimaryKey ? 'PK' : '', column.reference ? 'FK' : '', column.nullable ? 'NULL' : ''].filter(Boolean)
  }))
  const columns: DataTableColumn<FieldRow>[] = [
    { key: 'name', header: 'Field', cellClassName: 'w-[220px] max-w-[220px] truncate', render: (row) => <span className="font-medium text-zinc-100">{row.name}</span> },
    { key: 'type', header: 'Type', cellClassName: 'w-[150px] whitespace-nowrap', render: (row) => row.type },
    { key: 'flags', header: '', cellClassName: 'w-[1%] whitespace-nowrap', render: (row) => row.flags.map((flag) => <Pill key={flag}>{flag}</Pill>) },
    { key: 'value', header: 'Value', cellClassName: 'max-w-[520px] truncate', render: (row) => formatDbValue(data?.values[row.name] as DatabaseCellValue | undefined) },
    { key: 'actions', header: 'Actions', cellClassName: 'min-w-[150px]', render: (row) => <ActionLinks actions={data?.fieldActions[row.name] ?? []} /> }
  ]

  return (
    <div className="space-y-3">
      <PageHero title={table || 'Row'} subtitle="Generic row detail." />
      <div className="flex flex-wrap gap-3 text-xs">
        <Link to="/database" className="text-zinc-400 hover:text-zinc-100">&lt;- Tables</Link>
        <Link to={dbHref(table)} className="text-zinc-400 hover:text-zinc-100">&lt;- {table}</Link>
      </div>
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      {data?.actions.length ? (
        <ViewSection title="Actions" padding="sm">
          <ActionLinks actions={data.actions} />
        </ViewSection>
      ) : null}
      <ViewSection title="Fields" padding="sm">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.name}
          loading={isPending}
          loadingMessage="Loading row..."
          emptyMessage={data === null ? 'Row not found.' : 'No fields.'}
        />
      </ViewSection>
    </div>
  )
}

import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { DatabaseAction, DatabaseCellValue, DatabaseColumn, DatabaseRow } from '@djbrain/shared/database-inspector'
import { DataTable, type DataTableColumn } from '../../components/view/DataTable'
import { Pill } from '../../components/view/Pill'

export function dbHref(table: string, key?: string): string {
  return `/database/${encodeURIComponent(table)}${key ? `/${encodeURIComponent(key)}` : ''}`
}

export function ActionLinks({ actions }: { actions: DatabaseAction[] }): React.JSX.Element | null {
  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {actions.map((action) => (
        <Link key={`${action.label}:${action.href}`} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-800" to={action.href}>
          {action.label}
        </Link>
      ))}
    </div>
  )
}

export function formatDbValue(value: DatabaseCellValue | undefined): ReactNode {
  if (value == null) return <span className="text-zinc-600">NULL</span>
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? value : value.toFixed(3)
  if (typeof value === 'string') return <span title={value}>{value}</span>
  return <code className="text-[10px] text-zinc-300">{JSON.stringify(value)}</code>
}

export function columnLabel(column: DatabaseColumn): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      {column.name}
      {column.isPrimaryKey ? <Pill>PK</Pill> : null}
      {column.reference ? <Pill>FK</Pill> : null}
    </span>
  )
}

export function DatabaseRowsTable({
  columns,
  rows,
  table,
  loading,
  onRowClick
}: {
  columns: DatabaseColumn[]
  rows: DatabaseRow[]
  table: string
  loading?: boolean
  onRowClick: (row: DatabaseRow) => void
}): React.JSX.Element {
  const dataColumns: DataTableColumn<DatabaseRow>[] = [
    {
      key: '__open',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => <Link className="text-[10px] text-sky-300 hover:text-sky-200" to={dbHref(table, row.key)}>Open</Link>
    },
    ...columns.map((column) => ({
      key: column.name,
      header: columnLabel(column),
      cellClassName: 'max-w-[280px] truncate',
      render: (row: DatabaseRow) => formatDbValue(row.values[column.name])
    })),
    {
      key: '__actions',
      header: 'Actions',
      cellClassName: 'min-w-[130px]',
      render: (row) => <ActionLinks actions={row.actions} />
    }
  ]
  return (
    <DataTable
      columns={dataColumns}
      rows={rows}
      getRowKey={(row) => row.key}
      getRowTitle={(row) => JSON.stringify(row.values)}
      onRowClick={onRowClick}
      loading={loading}
      loadingMessage="Loading rows..."
      emptyMessage="No rows match."
      tableClassName="min-w-max"
    />
  )
}

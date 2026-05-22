import type { KeyboardEvent, ReactNode } from 'react'
import { cx } from './cx'

export type DataTableColumn<Row> = {
  key: string
  header: ReactNode
  render: (row: Row, index: number) => ReactNode
  headClassName?: string
  cellClassName?: string
}

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  getRowTitle,
  loading = false,
  loadingMessage = 'Loading…',
  emptyMessage = 'No rows.',
  rowClassName,
  onRowClick,
  tableClassName,
  borderless = false,
  className
}: {
  columns: DataTableColumn<Row>[]
  rows: Row[]
  getRowKey: (row: Row, index: number) => string
  getRowTitle?: (row: Row, index: number) => string | undefined
  loading?: boolean
  loadingMessage?: ReactNode
  emptyMessage?: ReactNode
  rowClassName?: string | ((row: Row, index: number) => string)
  onRowClick?: (row: Row, index: number) => void
  tableClassName?: string
  borderless?: boolean
  className?: string
}): React.JSX.Element {
  const rowBaseClass = onRowClick
    ? 'cursor-pointer border-t border-zinc-800 text-[11px] text-zinc-200 outline-none transition hover:bg-zinc-900/60 focus:bg-zinc-900/60'
    : 'border-t border-zinc-800 text-[11px] text-zinc-200'

  return (
    <div className={cx('overflow-x-auto rounded-xl bg-zinc-900/30', !borderless && 'border border-zinc-800', className)}>
      <table className={cx('w-full border-collapse text-left', tableClassName)}>
        <thead>
          <tr className="bg-zinc-950/50 text-[10px] uppercase tracking-wide text-zinc-500">
            {columns.map((column) => (
              <th key={column.key} className={cx('px-2 py-1.5 font-medium', column.headClassName)}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr className="border-t border-zinc-800">
              <td colSpan={columns.length} className="px-3 py-3 text-xs text-zinc-400">
                {loadingMessage}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr className="border-t border-zinc-800">
              <td colSpan={columns.length} className="px-3 py-3 text-xs text-zinc-500">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const interactiveProps = onRowClick
                ? {
                    tabIndex: 0,
                    role: 'link' as const,
                    onClick: () => onRowClick(row, index),
                    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onRowClick(row, index)
                      }
                    }
                  }
                : {}

              return (
                <tr
                  key={getRowKey(row, index)}
                  {...interactiveProps}
                  title={getRowTitle?.(row, index)}
                  className={cx(rowBaseClass, typeof rowClassName === 'function' ? rowClassName(row, index) : rowClassName)}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={cx('px-2 py-1.5 align-middle', column.cellClassName)}>
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

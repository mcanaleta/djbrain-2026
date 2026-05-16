import type { ReactNode } from 'react'

export function KV({
  rows,
  labelWidth = '130px'
}: {
  rows: Array<{ label: string; value: ReactNode }>
  labelWidth?: string
}): React.JSX.Element {
  return (
    <div className="gap-x-2 gap-y-1 text-xs" style={{ display: 'grid', gridTemplateColumns: `${labelWidth} 1fr` }}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <div className="text-zinc-500">{row.label}</div>
          <div className="min-w-0 break-all text-zinc-200">{row.value}</div>
        </div>
      ))}
    </div>
  )
}

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

type PanelTone = 'default' | 'hero' | 'muted'
type PanelPadding = 'sm' | 'md' | 'lg'

const PANEL_TONE_CLASS: Record<PanelTone, string> = {
  default: 'border-zinc-800 bg-zinc-900/40',
  hero: 'border-zinc-800 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_34%),linear-gradient(135deg,_rgba(24,24,27,0.94),_rgba(9,9,11,0.98))]',
  muted: 'border-zinc-800 bg-zinc-950/30'
}

const PANEL_PADDING_CLASS: Record<PanelPadding, string> = {
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5'
}

export function ViewPanel({
  children,
  tone = 'default',
  padding = 'md',
  className
}: {
  children: ReactNode
  tone?: PanelTone
  padding?: PanelPadding
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'rounded-xl border',
        PANEL_TONE_CLASS[tone],
        PANEL_PADDING_CLASS[padding],
        className
      )}
    >
      {children}
    </div>
  )
}

export function ViewSection({
  title,
  subtitle,
  aside,
  children,
  tone = 'default',
  padding = 'md',
  className,
  bodyClassName
}: {
  title?: ReactNode
  subtitle?: ReactNode
  aside?: ReactNode
  children: ReactNode
  tone?: PanelTone
  padding?: PanelPadding
  className?: string
  bodyClassName?: string
}): React.JSX.Element {
  const hasHeader = Boolean(title || subtitle || aside)

  return (
    <ViewPanel tone={tone} padding={padding} className={className}>
      {hasHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {title ? <div className="text-[13px] font-semibold text-zinc-100">{title}</div> : null}
            {subtitle ? <div className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</div> : null}
          </div>
          {aside}
        </div>
      ) : null}
      <div className={cx(hasHeader && 'mt-3', bodyClassName)}>{children}</div>
    </ViewPanel>
  )
}

export function PageHero({
  eyebrow,
  title,
  subtitle,
  badges,
  meta,
  aside,
  children
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  badges?: ReactNode
  meta?: ReactNode
  aside?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <ViewSection
      tone="hero"
      title={
        <div className="space-y-2">
          {eyebrow ? (
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{eyebrow}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 text-xl font-semibold tracking-tight text-zinc-100">{title}</div>
            {badges}
          </div>
          {subtitle ? <div className="text-[11px] text-zinc-400">{subtitle}</div> : null}
          {meta ? <div className="flex flex-wrap gap-1.5 text-[11px] text-zinc-400">{meta}</div> : null}
        </div>
      }
      aside={aside}
      padding="md"
    >
      {children}
    </ViewSection>
  )
}

type NoticeTone = 'default' | 'error' | 'warning' | 'success'

const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
  default: 'border-zinc-800 bg-zinc-950/30 text-zinc-400',
  error: 'border-red-800/70 bg-red-950/30 text-red-200',
  warning: 'border-amber-800/70 bg-amber-950/30 text-amber-200',
  success: 'border-emerald-800/70 bg-emerald-950/30 text-emerald-200'
}

export function Notice({
  children,
  tone = 'default',
  className
}: {
  children: ReactNode
  tone?: NoticeTone
  className?: string
}): React.JSX.Element {
  return (
    <div className={cx('rounded-xl border px-3 py-2 text-xs', NOTICE_TONE_CLASS[tone], className)}>
      {children}
    </div>
  )
}

export function EmptyState({
  message,
  className
}: {
  message: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Notice tone="default" className={cx('text-zinc-500', className)}>
      {message}
    </Notice>
  )
}

export function StatGrid({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cx('grid min-w-[220px] grid-cols-2 gap-2 text-xs', className)}>{children}</div>
}

export function StatCard({
  label,
  value,
  detail,
  className
}: {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <ViewPanel tone="muted" padding="sm" className={className}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] text-zinc-500">{detail}</div> : null}
    </ViewPanel>
  )
}

type ButtonTone = 'default' | 'primary' | 'success' | 'danger'
type ButtonSize = 'xs' | 'sm'
type PillTone = ButtonTone | 'muted'

const BUTTON_TONE_CLASS: Record<ButtonTone, string> = {
  default: 'border-zinc-700 bg-zinc-950/50 text-zinc-300 hover:border-amber-700/60 hover:text-amber-200',
  primary: 'border-amber-700/50 bg-amber-950/20 text-amber-200 hover:bg-amber-950/40',
  success: 'border-emerald-700/50 bg-emerald-950/20 text-emerald-200 hover:bg-emerald-950/40',
  danger: 'border-red-700/50 bg-red-950/20 text-red-200 hover:bg-red-950/40'
}

const PILL_TONE_CLASS: Record<PillTone, string> = {
  muted: 'border-zinc-700 text-zinc-400',
  default: 'border-zinc-700 text-zinc-300',
  primary: 'border-amber-700/50 text-amber-200',
  success: 'border-emerald-700/50 text-emerald-200',
  danger: 'border-red-700/50 text-red-200'
}

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px]',
  sm: 'px-3 py-1.5 text-xs'
}

export function ActionButton({
  children,
  tone = 'default',
  size = 'sm',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone
  size?: ButtonSize
}): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_TONE_CLASS[tone],
        BUTTON_SIZE_CLASS[size],
        className
      )}
    >
      {children}
    </button>
  )
}

export function Pill({
  children,
  tone = 'muted',
  pulse = false,
  className
}: {
  children: ReactNode
  tone?: PillTone
  pulse?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px]',
        PILL_TONE_CLASS[tone],
        className
      )}
    >
      {pulse ? <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {children}
    </span>
  )
}

export function IconButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-950/50 text-zinc-100 hover:border-amber-700/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  )
}

export function LabeledInput({
  label,
  className,
  inputClassName,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode
  className?: string
  inputClassName?: string
}): React.JSX.Element {
  return (
    <label className={cx('space-y-1', className)}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <input
        {...props}
        className={cx(
          'w-full rounded-lg border border-zinc-700 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-100 outline-none transition focus:border-amber-700/60',
          inputClassName
        )}
      />
    </label>
  )
}

export function QueryBar({
  label,
  value,
  onChange,
  onSubmit,
  buttonLabel = 'Search',
  busyLabel,
  isBusy = false,
  className
}: {
  label: ReactNode
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  buttonLabel?: ReactNode
  busyLabel?: ReactNode
  isBusy?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={cx('flex flex-wrap items-end gap-3', className)}>
      <LabeledInput
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1"
      />
      <ActionButton type="button" disabled={isBusy} onClick={onSubmit}>
        {isBusy ? (busyLabel ?? buttonLabel) : buttonLabel}
      </ActionButton>
    </div>
  )
}

export function ItemRow({
  title,
  subtitle,
  detail,
  prefix,
  badges,
  actions,
  className
}: {
  title: ReactNode
  subtitle?: ReactNode
  detail?: ReactNode
  prefix?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <ViewPanel tone="muted" padding="sm" className={className}>
      <div className="flex flex-wrap items-start gap-2">
        {prefix ? <div className="shrink-0">{prefix}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 text-xs font-medium text-zinc-100">{title}</div>
            {badges}
          </div>
          {subtitle ? <div className="mt-1 text-[11px] text-zinc-500">{subtitle}</div> : null}
          {detail ? <div className="mt-1 text-[11px] text-zinc-400">{detail}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </ViewPanel>
  )
}

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
  loading = false,
  loadingMessage = 'Loading…',
  emptyMessage = 'No rows.',
  rowClassName,
  onRowClick,
  tableClassName,
  className
}: {
  columns: DataTableColumn<Row>[]
  rows: Row[]
  getRowKey: (row: Row, index: number) => string
  loading?: boolean
  loadingMessage?: ReactNode
  emptyMessage?: ReactNode
  rowClassName?: string | ((row: Row, index: number) => string)
  onRowClick?: (row: Row, index: number) => void
  tableClassName?: string
  className?: string
}): React.JSX.Element {
  const rowBaseClass = onRowClick
    ? 'cursor-pointer border-t border-zinc-800 text-[11px] text-zinc-200 outline-none transition hover:bg-zinc-900/60 focus:bg-zinc-900/60'
    : 'border-t border-zinc-800 text-[11px] text-zinc-200'

  return (
    <div className={cx('overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/30', className)}>
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
                    role: 'link',
                    onClick: () => onRowClick(row, index),
                    onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
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
                  className={cx(
                    rowBaseClass,
                    typeof rowClassName === 'function' ? rowClassName(row, index) : rowClassName
                  )}
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

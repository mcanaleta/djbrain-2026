import { cx } from './cx'

export function Badge({
  label,
  className,
  title
}: {
  label: string
  className: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cx('inline-flex min-w-[3.25rem] items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-medium', className)}
    >
      {label}
    </span>
  )
}

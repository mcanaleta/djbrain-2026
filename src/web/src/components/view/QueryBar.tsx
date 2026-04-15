import type { ReactNode } from 'react'
import { ActionButton } from './ActionButton'
import { cx } from './cx'
import { LabeledInput } from './LabeledInput'

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
    <div className={cx('flex flex-wrap items-end gap-2', className)}>
      <LabeledInput label={label} value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 flex-1" />
      <ActionButton type="button" disabled={isBusy} onClick={onSubmit}>
        {isBusy ? (busyLabel ?? buttonLabel) : buttonLabel}
      </ActionButton>
    </div>
  )
}

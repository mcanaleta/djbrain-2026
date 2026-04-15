import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import { INPUT_LABEL_SIZE, INPUT_SIZE_CLASS, type InputSize } from './input-shared'

export function LabeledInput({
  label,
  className,
  inputClassName,
  size = 'default',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: ReactNode
  className?: string
  inputClassName?: string
  size?: InputSize
}): React.JSX.Element {
  return (
    <label className={cx(size === 'compact' ? 'space-y-1' : 'space-y-0.5', className)}>
      <div className={INPUT_LABEL_SIZE[size]}>{label}</div>
      <input
        {...props}
        className={cx(
          'w-full rounded-lg border bg-zinc-950/50 py-1 text-xs text-zinc-100 outline-none transition focus:border-amber-700/60',
          INPUT_SIZE_CLASS[size],
          inputClassName
        )}
      />
    </label>
  )
}

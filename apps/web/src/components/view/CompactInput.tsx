import type { InputHTMLAttributes, ReactNode } from 'react'
import { LabeledInput } from './LabeledInput'

export function CompactInput({
  label,
  className,
  inputClassName,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: ReactNode
  className?: string
  inputClassName?: string
}): React.JSX.Element {
  return <LabeledInput label={label} className={className} inputClassName={inputClassName} size="compact" {...props} />
}

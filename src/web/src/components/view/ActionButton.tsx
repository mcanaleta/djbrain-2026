import type { ButtonHTMLAttributes } from 'react'
import { BUTTON_SIZE_CLASS, BUTTON_TONE_CLASS, type ButtonSize, type ButtonTone } from './button-shared'
import { cx } from './cx'

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

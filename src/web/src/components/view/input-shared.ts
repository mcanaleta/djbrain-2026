export type InputSize = 'default' | 'compact'

export const INPUT_LABEL_SIZE: Record<InputSize, string> = {
  default: 'text-[10px] font-medium uppercase tracking-wide text-zinc-500',
  compact: 'text-[9px] uppercase tracking-wide text-zinc-500'
}

export const INPUT_SIZE_CLASS: Record<InputSize, string> = {
  default: 'border-zinc-700 px-2.5',
  compact: 'border-zinc-800 px-2'
}

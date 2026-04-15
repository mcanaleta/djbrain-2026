export type ButtonTone = 'default' | 'primary' | 'success' | 'danger'
export type ButtonSize = 'xs' | 'sm'
export type PillTone = ButtonTone | 'muted'

export const BUTTON_TONE_CLASS: Record<ButtonTone, string> = {
  default: 'border-zinc-700 bg-zinc-950/50 text-zinc-300 hover:border-amber-700/60 hover:text-amber-200',
  primary: 'border-amber-700/50 bg-amber-950/20 text-amber-200 hover:bg-amber-950/40',
  success: 'border-emerald-700/50 bg-emerald-950/20 text-emerald-200 hover:bg-emerald-950/40',
  danger: 'border-red-700/50 bg-red-950/20 text-red-200 hover:bg-red-950/40'
}

export const PILL_TONE_CLASS: Record<PillTone, string> = {
  muted: 'border-zinc-700 text-zinc-400',
  default: 'border-zinc-700 text-zinc-300',
  primary: 'border-amber-700/50 text-amber-200',
  success: 'border-emerald-700/50 text-emerald-200',
  danger: 'border-red-700/50 text-red-200'
}

export const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px]',
  sm: 'px-3 py-1.5 text-xs'
}

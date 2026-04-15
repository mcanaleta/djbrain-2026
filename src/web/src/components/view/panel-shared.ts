export type PanelTone = 'default' | 'hero' | 'muted'
export type PanelPadding = 'sm' | 'md' | 'lg'

export const PANEL_TONE_CLASS: Record<PanelTone, string> = {
  default: 'border-zinc-800 bg-zinc-900/40',
  hero: 'border-zinc-800 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_34%),linear-gradient(135deg,_rgba(24,24,27,0.94),_rgba(9,9,11,0.98))]',
  muted: 'border-zinc-800 bg-zinc-950/30'
}

export const PANEL_PADDING_CLASS: Record<PanelPadding, string> = {
  sm: 'p-2',
  md: 'p-3',
  lg: 'p-4'
}

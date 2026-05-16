function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}

export function mixerPercentFromTime(time: number, duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? clampPercent((time / duration) * 100) : 0
}

export function mixerTimeFromPercent(percent: number, duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? (clampPercent(percent) / 100) * duration : 0
}

export function isMixerTrackAudible(filename: string, muted: ReadonlySet<string>, solo: ReadonlySet<string>): boolean {
  return solo.size > 0 ? solo.has(filename) : !muted.has(filename)
}

export function toggleMixerSolo(current: ReadonlySet<string>, filename: string): Set<string> {
  return current.size === 1 && current.has(filename) ? new Set() : new Set([filename])
}

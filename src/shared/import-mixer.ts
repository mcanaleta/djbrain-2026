export function isMixerTrackAudible(filename: string, muted: ReadonlySet<string>, solo: ReadonlySet<string>): boolean {
  return solo.size > 0 ? solo.has(filename) : !muted.has(filename)
}

export function toggleMixerSolo(current: ReadonlySet<string>, filename: string): Set<string> {
  return current.size === 1 && current.has(filename) ? new Set() : new Set([filename])
}

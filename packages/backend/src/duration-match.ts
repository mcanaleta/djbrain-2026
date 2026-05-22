export function isDurationClose(actual: number | null | undefined, expected: number | null | undefined, ratio = 0.15): boolean {
  return actual == null || expected == null || expected <= 0 || Math.abs(actual - expected) / expected <= ratio
}

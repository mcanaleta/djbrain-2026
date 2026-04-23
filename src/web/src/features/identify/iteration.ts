const prefix = 'identify:iteration:'

const keyFor = (scope: 'downloads' | 'collection', query: string, filter: string): string =>
  `${prefix}${scope}:${filter}:${query.trim()}`

export function storeIdentifyIteration(scope: 'downloads' | 'collection', query: string, filter: string, ids: number[]): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(keyFor(scope, query, filter), JSON.stringify(ids))
  } catch {
    // Ignore storage failures; next/back simply falls back to the list page.
  }
}

export function readIdentifyIteration(scope: 'downloads' | 'collection', query: string, filter: string): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(keyFor(scope, query, filter))
    const value = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item) && item > 0) : []
  } catch {
    // Ignore storage failures; next/back simply falls back to the list page.
    return []
  }
}

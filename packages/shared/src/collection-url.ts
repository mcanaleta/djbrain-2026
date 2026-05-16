export function buildCollectionItemPath(id: number, _filename?: string): string {
  return `/collection/item/${encodeURIComponent(String(id))}`
}

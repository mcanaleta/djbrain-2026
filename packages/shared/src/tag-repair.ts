import type { CollectionItemDetails, RecordingCanonical } from './api.ts'

export type TagRepairField = 'artist' | 'title' | 'year'
export type TagRepairRow = { field: TagRepairField; label: string; current: string | null; expected: string | null; matches: boolean }

function text(value: string | null | undefined): string | null {
  return value?.trim() || null
}

function same(left: string | null, right: string | null): boolean {
  return (left ?? '').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '').trim() === (right ?? '').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '').trim()
}

export function buildTagRepairRows(tags: CollectionItemDetails['tags'], canonical: RecordingCanonical | null): TagRepairRow[] {
  return ([
    ['artist', 'TAG Artist match', text(tags?.artist), text(canonical?.artist)],
    ['title', 'TAG Title match', text(tags?.title), text(canonical?.title)],
    ['year', 'TAG Year match', text(tags?.year), text(canonical?.year)]
  ] as const).map(([field, label, current, expected]) => ({ field, label, current, expected, matches: same(current, expected) }))
}

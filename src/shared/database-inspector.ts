export type DatabaseCellValue = string | number | boolean | null | Record<string, unknown> | unknown[]

export type DatabaseRowKey =
  | { kind: 'pk'; values: Record<string, DatabaseCellValue> }
  | { kind: 'ctid'; value: string }

export type DatabaseReference = {
  foreignTable: string
  foreignColumn: string
}

export type DatabaseColumn = {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  reference: DatabaseReference | null
}

export type DatabaseAction = {
  label: string
  href: string
}

export type DatabaseTableSummary = {
  name: string
  rowCount: number
  columns: DatabaseColumn[]
  primaryKey: string[]
}

export type DatabaseRow = {
  key: string
  values: Record<string, DatabaseCellValue>
  actions: DatabaseAction[]
}

export type DatabaseTableRows = {
  table: DatabaseTableSummary
  rows: DatabaseRow[]
  filter: string
  limit: number
  offset: number
}

export type DatabaseRowDetails = DatabaseRow & {
  table: DatabaseTableSummary
  fieldActions: Record<string, DatabaseAction[]>
}

const filenameFields = new Set([
  'filename',
  'collection_filename',
  'source_collection_filename',
  'origin_source_collection_filename',
  'local_filename',
  'imported_filename',
  'replacement_filename',
  'archive_filename'
])

const inferredReferences: Record<string, DatabaseReference> = {
  recording_id: { foreignTable: 'recordings', foreignColumn: 'id' },
  merged_into_recording_id: { foreignTable: 'recordings', foreignColumn: 'id' },
  proposed_recording_id: { foreignTable: 'recordings', foreignColumn: 'id' },
  want_list_id: { foreignTable: 'want_list', foreignColumn: 'id' },
  selected_download_id: { foreignTable: 'download_attempts', foreignColumn: 'id' },
  chosen_claim_id: { foreignTable: 'recording_source_claims', foreignColumn: 'id' }
}

export function encodeDatabaseRowKey(key: DatabaseRowKey): string {
  const bytes = new TextEncoder().encode(JSON.stringify(key))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return codec().btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function decodeDatabaseRowKey(value: string): DatabaseRowKey {
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const bytes = Uint8Array.from(codec().atob(padded), (char) => char.charCodeAt(0))
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DatabaseRowKey
  if (parsed.kind === 'ctid' && typeof parsed.value === 'string') return parsed
  if (parsed.kind === 'pk' && parsed.values && typeof parsed.values === 'object') return parsed
  throw new Error('Invalid database row key.')
}

export function buildDatabaseRowActions(table: string, values: Record<string, DatabaseCellValue>): DatabaseAction[] {
  const actions: DatabaseAction[] = []
  const id = primitive(values['id'])
  const filename = stringValue(values['filename'])
  if (table === 'collection_files' && id != null) actions.push({ label: 'Track', href: `/collection/item/${encodeURIComponent(String(id))}` })
  if (table === 'collection_files' && filename) actions.push({ label: 'Identify', href: `/identify?scope=collection&filename=${encodeURIComponent(filename)}` })
  if (table === 'want_list' && id != null) actions.push({ label: 'Wanted Item', href: `/wantlist/${encodeURIComponent(String(id))}` })
  const wantListId = primitive(values['want_list_id'])
  if (table === 'download_attempts' && wantListId != null) actions.push({ label: 'Wanted Item', href: `/wantlist/${encodeURIComponent(String(wantListId))}` })
  return actions
}

export function buildDatabaseFieldActions(name: string, value: DatabaseCellValue, reference?: DatabaseReference | null): DatabaseAction[] {
  const actions: DatabaseAction[] = []
  const scalar = primitive(value)
  const text = stringValue(value)
  const linkedReference = reference ?? inferredReferences[name] ?? null
  if (linkedReference && scalar != null) {
    actions.push({
      label: linkedReference.foreignTable,
      href: `/database/${encodeURIComponent(linkedReference.foreignTable)}/${encodeDatabaseRowKey({ kind: 'pk', values: { [linkedReference.foreignColumn]: scalar } })}`
    })
  }
  if (/discogs_release_id$/u.test(name) && scalar != null) actions.push({ label: 'Discogs', href: `/discogs/release/${encodeURIComponent(String(scalar))}` })
  const releaseId = text?.match(/discogs:release:(\d+)/i)?.[1]
  if (releaseId) actions.push({ label: 'Discogs', href: `/discogs/release/${releaseId}` })
  if (filenameFields.has(name) && text) actions.push({ label: 'Collection Lookup', href: `/database/collection_files?filter=${encodeURIComponent(text)}` })
  return actions
}

function primitive(value: DatabaseCellValue | undefined): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null ? value ?? null : null
}

function stringValue(value: DatabaseCellValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function codec(): { atob(value: string): string; btoa(value: string): string } {
  return globalThis as unknown as { atob(value: string): string; btoa(value: string): string }
}

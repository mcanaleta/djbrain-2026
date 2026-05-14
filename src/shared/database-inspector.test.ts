import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDatabaseFieldActions,
  buildDatabaseRowActions,
  decodeDatabaseRowKey,
  encodeDatabaseRowKey
} from './database-inspector.ts'

test('database row keys round-trip primary key values', () => {
  const key = encodeDatabaseRowKey({ kind: 'pk', values: { id: 42, name: 'tracks/one.mp3' } })
  assert.deepEqual(decodeDatabaseRowKey(key), { kind: 'pk', values: { id: 42, name: 'tracks/one.mp3' } })
})

test('database row actions link app concepts from generic rows', () => {
  assert.deepEqual(
    buildDatabaseRowActions('collection_files', { id: 1931, filename: 'songs/a.mp3' }).map((action) => action.href),
    ['/collection/item/1931', '/identify?scope=collection&filename=songs%2Fa.mp3']
  )
  assert.equal(buildDatabaseRowActions('want_list', { id: 9 })[0]?.href, '/wantlist/9')
})

test('database field actions link foreign keys and discogs keys', () => {
  assert.deepEqual(
    buildDatabaseFieldActions('recording_id', 77, { foreignTable: 'recordings', foreignColumn: 'id' }).map((action) => action.href),
    [`/database/recordings/${encodeDatabaseRowKey({ kind: 'pk', values: { id: 77 } })}`]
  )
  assert.equal(
    buildDatabaseFieldActions('external_key', 'discogs:release:123:track:A1')[0]?.href,
    '/discogs/release/123'
  )
  assert.equal(
    buildDatabaseFieldActions('want_list_id', 9)[0]?.href,
    `/database/want_list/${encodeDatabaseRowKey({ kind: 'pk', values: { id: 9 } })}`
  )
})

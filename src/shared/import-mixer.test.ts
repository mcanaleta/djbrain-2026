import assert from 'node:assert/strict'
import test from 'node:test'
import { isMixerTrackAudible, toggleMixerSolo } from './import-mixer.ts'

test('solo isolates one mixer row and can be toggled off', () => {
  const soloA = toggleMixerSolo(new Set(), 'a')
  assert.deepEqual([...soloA], ['a'])
  assert.equal(isMixerTrackAudible('a', new Set(['a']), soloA), true)
  assert.equal(isMixerTrackAudible('b', new Set(), soloA), false)
  assert.deepEqual([...toggleMixerSolo(soloA, 'b')], ['b'])
  assert.deepEqual([...toggleMixerSolo(new Set(['b']), 'b')], [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mixerPercentFromTime, mixerTimeFromPercent, isMixerTrackAudible, toggleMixerSolo } from './import-mixer.ts'

test('solo isolates one mixer row and can be toggled off', () => {
  const soloA = toggleMixerSolo(new Set(), 'a')
  assert.deepEqual([...soloA], ['a'])
  assert.equal(isMixerTrackAudible('a', new Set(['a']), soloA), true)
  assert.equal(isMixerTrackAudible('b', new Set(), soloA), false)
  assert.deepEqual([...toggleMixerSolo(soloA, 'b')], ['b'])
  assert.deepEqual([...toggleMixerSolo(new Set(['b']), 'b')], [])
})

test('mixer maps track times through percent, not absolute seconds', () => {
  const percent = mixerPercentFromTime(30, 300)
  assert.equal(percent, 10)
  assert.equal(mixerTimeFromPercent(percent, 600), 60)
  assert.equal(mixerTimeFromPercent(125, 100), 100)
  assert.equal(mixerPercentFromTime(10, 0), 0)
})

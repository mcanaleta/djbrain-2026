import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isDurationClose } from '@djbrain/backend/duration-match.ts'

describe('duration matching', () => {
  it('rejects known durations over the tolerance', () => {
    assert.equal(isDurationClose(240, 502), false)
    assert.equal(isDurationClose(430, 502), true)
  })

  it('keeps unknown durations', () => {
    assert.equal(isDurationClose(null, 502), true)
    assert.equal(isDurationClose(240, null), true)
  })
})

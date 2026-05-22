import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldPollWantListItem } from './want-list-polling.ts'

describe('shouldPollWantListItem', () => {
  it('polls while the downloader worker may be updating the wanted item', () => {
    assert.equal(shouldPollWantListItem('queued'), true)
    assert.equal(shouldPollWantListItem('searching'), true)
    assert.equal(shouldPollWantListItem('downloading'), true)
    assert.equal(shouldPollWantListItem('downloaded'), true)
    assert.equal(shouldPollWantListItem('error'), false)
  })
})

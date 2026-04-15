import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCanonicalNormKey, scoreRecordingCandidate } from '../backend/recording-identity-service.ts'

describe('recording identity helpers', () => {
  it('normalizes canonical keys consistently', () => {
    assert.equal(
      buildCanonicalNormKey({
        artist: 'Xavi Metralla',
        title: 'Metramorphosis',
        version: 'Original Mix',
        year: null
      }),
      'xavi metralla:metramorphosis:original mix'
    )
  })

  it('scores the same edit as a strong match', () => {
    const score = scoreRecordingCandidate(
      {
        artist: 'Xavi Metralla',
        title: 'Metramorphosis',
        version: 'Original Mix',
        year: '1998',
        durationSeconds: 381,
        releaseTitle: 'Metramorphosis',
        provider: 'filename'
      },
      null,
      {
        id: 1,
        canonical: {
          artist: 'Xavi Metralla',
          title: 'Metramorphosis',
          version: 'Original Mix',
          year: '1998'
        },
        confidence: 90,
        reviewState: 'auto',
        metadataLocked: false,
        mergedIntoRecordingId: null,
        claims: []
      }
    )
    assert.equal(score, 75)
  })

  it('penalizes conflicting versions', () => {
    const score = scoreRecordingCandidate(
      {
        artist: 'Xavi Metralla',
        title: 'Metramorphosis',
        version: 'Remix',
        year: '1998',
        durationSeconds: 381,
        releaseTitle: 'Metramorphosis',
        provider: 'filename'
      },
      null,
      {
        id: 1,
        canonical: {
          artist: 'Xavi Metralla',
          title: 'Metramorphosis',
          version: 'Original Mix',
          year: '1998'
        },
        confidence: 90,
        reviewState: 'auto',
        metadataLocked: false,
        mergedIntoRecordingId: null,
        claims: []
      }
    )
    assert.equal(score, 40)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseTrackTitle } from './track-title-parser.ts'

describe('parseTrackTitle', () => {
  describe('parenthetical versions', () => {
    it('extracts version from trailing parens', () => {
      const result = parseTrackTitle('Protec (Extended Version)')
      assert.deepEqual(result, { title: 'Protec', version: 'Extended Version' })
    })

    it('extracts Original Mix', () => {
      const result = parseTrackTitle('Shed (Original Mix)')
      assert.deepEqual(result, { title: 'Shed', version: 'Original Mix' })
    })

    it('extracts Radio Edit', () => {
      const result = parseTrackTitle('Signal (Radio Edit)')
      assert.deepEqual(result, { title: 'Signal', version: 'Radio Edit' })
    })

    it('handles extra spaces around parens', () => {
      const result = parseTrackTitle('Track   (Club Mix)  ')
      assert.deepEqual(result, { title: 'Track', version: 'Club Mix' })
    })
  })

  describe('bracketed versions', () => {
    it('extracts version from trailing brackets', () => {
      const result = parseTrackTitle('Track [Dub Mix]')
      assert.deepEqual(result, { title: 'Track', version: 'Dub Mix' })
    })

    it('extracts version from trailing brackets with spaces', () => {
      const result = parseTrackTitle('Deep Signal [VIP Mix]  ')
      assert.deepEqual(result, { title: 'Deep Signal', version: 'VIP Mix' })
    })
  })

  describe('multiple parentheticals', () => {
    it('takes last parenthetical as version', () => {
      const result = parseTrackTitle('Track (feat. Artist) (Extended)')
      assert.deepEqual(result, { title: 'Track (feat. Artist)', version: 'Extended' })
    })

    it('takes last brackets as version', () => {
      const result = parseTrackTitle('Track [Vocal] [Instrumental]')
      assert.deepEqual(result, { title: 'Track [Vocal]', version: 'Instrumental' })
    })

    it('ignores trailing vinyl side markers after a real version', () => {
      const result = parseTrackTitle('Back To The O.V.N.I. Sound (Ovni Version) (A)')
      assert.deepEqual(result, { title: 'Back To The O.V.N.I. Sound', version: 'Ovni Version' })
    })

    it('ignores trailing year markers after a real version', () => {
      const result = parseTrackTitle('Teology Civilization (Dj. Richard y Johnny Bass Version) (1998)')
      assert.deepEqual(result, { title: 'Teology Civilization', version: 'Dj. Richard y Johnny Bass Version' })
    })
  })

  describe('no version', () => {
    it('strips leading track markers', () => {
      const result = parseTrackTitle('A1 - Diabolica')
      assert.deepEqual(result, { title: 'Diabolica', version: null })
    })

    it('keeps non-version parentheticals as part of the title', () => {
      const result = parseTrackTitle("That's The Way (I Like It)")
      assert.deepEqual(result, { title: "That's The Way (I Like It)", version: null })
    })

    it('keeps title parentheticals that are not mix markers', () => {
      const result = parseTrackTitle('More Spell on You (One More Time)')
      assert.deepEqual(result, { title: 'More Spell on You (One More Time)', version: null })
    })

    it('returns null version for plain title', () => {
      const result = parseTrackTitle('Simple Track')
      assert.deepEqual(result, { title: 'Simple Track', version: null })
    })

    it('does not split hyphenated titles when the suffix is not version-like', () => {
      const result = parseTrackTitle('Face To Face - Heart To Heart')
      assert.deepEqual(result, { title: 'Face To Face - Heart To Heart', version: null })
    })

    it('trims whitespace from plain title', () => {
      const result = parseTrackTitle('  Track Name  ')
      assert.deepEqual(result, { title: 'Track Name', version: null })
    })
  })

  describe('dash versions', () => {
    it('extracts remaster suffixes after a dash', () => {
      const result = parseTrackTitle("It's My Life - 1997 Remaster")
      assert.deepEqual(result, { title: "It's My Life", version: '1997 Remaster' })
    })
  })

  describe('edge cases', () => {
    it('returns original if title part would be empty', () => {
      const result = parseTrackTitle('(Extended Version)')
      assert.deepEqual(result, { title: '(Extended Version)', version: null })
    })

    it('returns original if version part would be empty', () => {
      const result = parseTrackTitle('Track ()')
      assert.deepEqual(result, { title: 'Track ()', version: null })
    })

    it('handles empty string', () => {
      const result = parseTrackTitle('')
      assert.deepEqual(result, { title: '', version: null })
    })
  })
})

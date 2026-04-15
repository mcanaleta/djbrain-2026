import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseImportFilename } from './import-filename.ts'

describe('parseImportFilename', () => {
  it('strips vinyl side markers from the title portion', () => {
    assert.deepEqual(
      parseImportFilename(
        'hasoulseek/complete/(71-329) xavi metralla - diabolica/01_xavi_metralla_-_a1_-_diabolica-bc.mp3'
      ),
      {
        artist: 'xavi metralla',
        title: 'diabolica',
        version: null,
        year: null
      }
    )
  })

  it('strips garbage numeric tails from the title portion', () => {
    assert.deepEqual(
      parseImportFilename(
        'hasoulseek/complete/[NM5079MX] Pastis and Buenri - Adrenalin/02_pastis_and_buenri_-_b1_-_happy_melody_639102208197607690.mp3'
      ),
      {
        artist: 'pastis and buenri',
        title: 'happy melody',
        version: null,
        year: null
      }
    )
  })

  it('parses release-rip basenames that repeat the artist without spaced dashes', () => {
    assert.deepEqual(
      parseImportFilename(
        'hasoulseek/complete/Daft Punk - Musique Vol. 1 1993-2005 (2006) [FLAC] {TOCP-66538 JP} - CD/07-daft_punk-one_more_time_(short_radio_edit).flac'
      ),
      {
        artist: 'Daft Punk',
        title: 'one more time',
        version: 'short radio edit',
        year: '2006'
      }
    )
  })

  it('parses scene-style artist-title basenames with bare dashes', () => {
    assert.deepEqual(
      parseImportFilename(
        'hasoulseek/complete/VA-World_Of_Trance_Volume_8-(302_4081-2)-2CD-FLAC-1998-WRE/210-barbarian-teology_civilization_(techno_version).flac'
      ),
      {
        artist: 'barbarian',
        title: 'teology civilization',
        version: 'techno version',
        year: '1998'
      }
    )
  })

  it('reverses title-artist filenames when the left side is clearly a track remix title', () => {
    assert.deepEqual(
      parseImportFilename('soulseek/complete/PIRACY UK/other classic trance/The One (Green Martian Remix) - dee dee.mp3'),
      {
        artist: 'dee dee',
        title: 'The One',
        version: 'Green Martian Remix',
        year: null
      }
    )
  })

  it('does not treat volume-like album names as track versions', () => {
    assert.deepEqual(
      parseImportFilename('soulseek/complete/nodanu20/Music/01_Robert_Miles_-_Children_(One_Shot_90_Vol._1).mp3'),
      {
        artist: 'Robert Miles',
        title: 'Children',
        version: null,
        year: null
      }
    )
  })
})

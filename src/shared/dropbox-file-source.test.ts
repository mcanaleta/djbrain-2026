import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDropboxScanPaths,
  dropboxEntriesToFileStates,
  readDropboxFileSourceConfig
} from '../backend/dropbox-file-source.ts'

describe('readDropboxFileSourceConfig', () => {
  it('requires explicit dropbox mode and keeps secrets out of app settings', () => {
    const config = readDropboxFileSourceConfig(
      { musicFolderPath: '/music', songsFolderPath: 'songs', downloadFolderPaths: ['soulseek/complete'] },
      {
        DJBRAIN_FILE_ACCESS_MODE: 'dropbox',
        DJBRAIN_DROPBOX_ACCESS_TOKEN: 'token',
        DJBRAIN_DROPBOX_MUSIC_PATH: '/music'
      }
    )

    assert.equal(config?.accessToken, 'token')
    assert.equal(config?.musicPath, '/music')
  })
})

describe('buildDropboxScanPaths', () => {
  it('builds songs and download roots under the configured Dropbox music path', () => {
    assert.deepEqual(
      buildDropboxScanPaths({
        accessToken: 'token',
        musicPath: '/music',
        songsFolderPath: 'songs',
        downloadFolderPaths: ['soulseek/complete', '/hasoulseek/complete/']
      }),
      ['/music/songs', '/music/soulseek/complete', '/music/hasoulseek/complete']
    )
  })
})

describe('dropboxEntriesToFileStates', () => {
  it('keeps supported audio files under scan roots and strips the Dropbox music root', () => {
    const files = dropboxEntriesToFileStates({
      accessToken: 'token',
      musicPath: '/music',
      songsFolderPath: 'songs',
      downloadFolderPaths: ['soulseek/complete']
    }, [
      { '.tag': 'file', path_display: '/music/songs/A/B.mp3', server_modified: '2026-05-15T10:00:00Z', size: 12 },
      { '.tag': 'file', path_display: '/music/soulseek/complete/C.flac', server_modified: '2026-05-15T10:01:00Z', size: 13 },
      { '.tag': 'file', path_display: '/music/songs/cover.jpg', server_modified: '2026-05-15T10:02:00Z', size: 14 },
      { '.tag': 'folder', path_display: '/music/songs/A' }
    ])

    assert.deepEqual(files.map((file) => file.filename), ['songs/A/B.mp3', 'soulseek/complete/C.flac'])
    assert.equal(files[0]?.filesize, 12)
    assert.equal(files[0]?.mtimeMs, Date.parse('2026-05-15T10:00:00Z'))
  })
})

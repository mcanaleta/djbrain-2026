import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDropboxScanPaths,
  dropboxCachePathForFilename,
  dropboxPathForFilename,
  dropboxEntriesToFileStates,
  readDropboxAccessToken,
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

  it('can read the Dropbox token from an rclone config', () => {
    const config = readDropboxFileSourceConfig(
      { musicFolderPath: '/music', songsFolderPath: 'songs', downloadFolderPaths: [] },
      {
        DJBRAIN_FILE_ACCESS_MODE: 'dropbox',
        DJBRAIN_DROPBOX_RCLONE_REMOTE: 'dropbox'
      },
      `[dropbox]\ntype = dropbox\ntoken = {"access_token":"sl.test","refresh_token":"refresh","expiry":"2026-05-15T14:45:35+02:00"}`
    )

    assert.equal(config?.accessToken, 'sl.test')
  })
})

describe('readDropboxAccessToken', () => {
  it('prefers explicit env token over rclone config contents', () => {
    assert.equal(
      readDropboxAccessToken({ DJBRAIN_DROPBOX_ACCESS_TOKEN: 'env-token' }, '[dropbox]\ntoken = {"access_token":"rclone-token"}'),
      'env-token'
    )
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

describe('dropboxPathForFilename', () => {
  it('maps a collection-relative filename to a Dropbox API path', () => {
    assert.equal(
      dropboxPathForFilename({
        accessToken: 'token',
        musicPath: '/music',
        songsFolderPath: 'songs',
        downloadFolderPaths: []
      }, 'songs/1999/A - B.mp3'),
      '/music/songs/1999/A - B.mp3'
    )
  })
})

describe('dropboxCachePathForFilename', () => {
  it('keeps cached files inside the configured cache root', () => {
    assert.match(
      dropboxCachePathForFilename('/tmp/cache', 'songs/A - B.mp3').replace(/\\/g, '/'),
      /\/tmp\/cache\/songs\/A - B\.mp3$/u
    )
    assert.throws(() => dropboxCachePathForFilename('/tmp/cache', '../escape.mp3'), /outside/)
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

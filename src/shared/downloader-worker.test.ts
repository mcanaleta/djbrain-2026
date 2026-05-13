import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDownloadRequests,
  buildUpgradeWantedMigration,
  type DownloadAttemptSeed,
  type WantedDownloadCandidate
} from '../backend/downloader-worker-planning.ts'

const candidate = (filename: string, score: number, locked: boolean = false): WantedDownloadCandidate => ({
  username: 'user',
  filename,
  size: 1000 + score,
  score,
  bitrate: 320,
  durationSeconds: 300,
  queueLength: 0,
  hasFreeUploadSlot: true,
  uploadSpeed: 100,
  isLocked: locked,
  extension: 'mp3'
})

describe('buildDownloadRequests', () => {
  it('picks top unlocked candidates up to remaining target slots', () => {
    const requests = buildDownloadRequests({
      wantListId: 7,
      query: 'artist title',
      searchId: 'search-1',
      targetDownloadCount: 3,
      candidates: [candidate('a.mp3', 90), candidate('locked.mp3', 95, true), candidate('b.mp3', 80), candidate('c.mp3', 70)],
      existingAttempts: [{ status: 'downloaded', username: 'old', remoteFilename: 'old.mp3', remoteSize: 1 }]
    })

    assert.deepEqual(requests.map((item) => item.remoteFilename), ['a.mp3', 'b.mp3'])
  })

  it('skips remote files already attempted for the wanted record', () => {
    const existingAttempts: DownloadAttemptSeed[] = [
      { status: 'failed', username: 'user', remoteFilename: 'a.mp3', remoteSize: 1090 },
      { status: 'requested', username: 'user', remoteFilename: 'b.mp3', remoteSize: 1080 }
    ]
    const requests = buildDownloadRequests({
      wantListId: 7,
      query: 'artist title',
      searchId: 'search-1',
      targetDownloadCount: 3,
      candidates: [candidate('a.mp3', 90), candidate('b.mp3', 80), candidate('c.mp3', 70)],
      existingAttempts
    })

    assert.deepEqual(requests.map((item) => item.remoteFilename), ['c.mp3'])
  })
})

describe('buildUpgradeWantedMigration', () => {
  it('converts upgrade local candidates into downloaded attempts with origin snapshots', () => {
    const migration = buildUpgradeWantedMigration({
      id: 4,
      collectionFilename: 'songs/1996/Farmdoctors - El Guebo.mp3',
      status: 'downloaded',
      searchArtist: 'Farmdoctors',
      searchTitle: 'El Guebo',
      searchVersion: null,
      localCandidates: [{
        filename: 'soulseek/complete/Farmdoctors/el-guebo.flac',
        filesize: 123,
        durationSeconds: 301,
        source: 'auto_download',
        sourceUsername: 'peer',
        sourceFilename: 'Farmdoctors/el-guebo.flac'
      }]
    })

    assert.equal(migration.want.wantKind, 'replacement')
    assert.equal(migration.want.sourceCollectionFilename, 'songs/1996/Farmdoctors - El Guebo.mp3')
    assert.equal(migration.attempts[0]?.originArtist, 'Farmdoctors')
    assert.equal(migration.attempts[0]?.localFilename, 'soulseek/complete/Farmdoctors/el-guebo.flac')
    assert.equal(migration.attempts[0]?.status, 'downloaded')
  })
})

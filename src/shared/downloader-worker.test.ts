import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDownloadRequests,
  buildExpectedDownloadFilename,
  planDownloadAttemptFileLinks,
  downloadAttemptStatusFromSlskdState,
  wantListStatusAfterAttempt,
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
  it('adds the expected collection path for each requested download', () => {
    const requests = buildDownloadRequests({
      wantListId: 7,
      query: 'artist title',
      searchId: 'search-1',
      targetDownloadCount: 1,
      downloadFolderPaths: ['hasoulseek/complete'],
      candidates: [candidate('#MAKINA/Mega`Lo Mania - Close Your Eyes.mp3', 90)],
      existingAttempts: []
    })

    assert.equal(requests[0]?.expectedLocalFilename, 'hasoulseek/complete/#MAKINA/Mega`Lo Mania - Close Your Eyes.mp3')
  })

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
      recordingId: 88,
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
    assert.equal(migration.want.recordingId, 88)
    assert.equal(migration.want.sourceCollectionFilename, 'songs/1996/Farmdoctors - El Guebo.mp3')
    assert.equal(migration.attempts[0]?.originRecordingId, 88)
    assert.equal(migration.attempts[0]?.originArtist, 'Farmdoctors')
    assert.equal(migration.attempts[0]?.localFilename, 'soulseek/complete/Farmdoctors/el-guebo.flac')
    assert.equal(migration.attempts[0]?.status, 'downloaded')
  })
})

describe('buildExpectedDownloadFilename', () => {
  it('derives a Dropbox-relative expected path without touching disk', () => {
    assert.equal(
      buildExpectedDownloadFilename(['soulseek/complete'], '@@peer\\Soulseek Downloads\\complete\\Folder\\Track.flac'),
      'soulseek/complete/Folder/Track.flac'
    )
  })

  it('uses null when no completed-download prefix is configured', () => {
    assert.equal(buildExpectedDownloadFilename([], 'Track.mp3'), null)
  })
})

describe('planDownloadAttemptFileLinks', () => {
  it('links existing files by remote tail when the configured download root changed', () => {
    const links = planDownloadAttemptFileLinks([{
      id: 53,
      wantListId: 9,
      status: 'downloaded',
      expectedLocalFilename: 'soulseek/complete/MUSIC/Spd/02-spd_-_a_great_reward_(spd_base)-tia.flac',
      remoteFilename: 'MUSIC\\Spd\\02-spd_-_a_great_reward_(spd_base)-tia.flac',
      remoteSize: 40941219,
      localFilename: null,
      localFilesize: null
    }], [{
      filename: 'hasoulseek/complete/Spd/02-spd_-_a_great_reward_(spd_base)-tia.flac',
      filesize: 40941219
    }])

    assert.deepEqual(links.map((link) => [link.attemptId, link.filename]), [[53, 'hasoulseek/complete/Spd/02-spd_-_a_great_reward_(spd_base)-tia.flac']])
  })

  it('uses Soulseek conflict suffixes and size to repair duplicate local links', () => {
    const links = planDownloadAttemptFileLinks([{
      id: 13,
      wantListId: 9,
      status: 'downloaded',
      expectedLocalFilename: null,
      remoteFilename: '@@peer\\Clubland X-treme Hardcore 4 (2007)\\1-02 Darren Styles & Francis Hill - Come Running.flac',
      remoteSize: 41129379,
      localFilename: 'hasoulseek/complete/Clubland X-treme Hardcore 4 (2007)/1-02 Darren Styles & Francis Hill - Come Running.flac',
      localFilesize: 41004560
    }], [{
      filename: 'hasoulseek/complete/Clubland X-treme Hardcore 4 (2007)/1-02 Darren Styles & Francis Hill - Come Running_639142018835027264.flac',
      filesize: 41129379
    }])

    assert.equal(links[0]?.filename, 'hasoulseek/complete/Clubland X-treme Hardcore 4 (2007)/1-02 Darren Styles & Francis Hill - Come Running_639142018835027264.flac')
  })
})

describe('downloadAttemptStatusFromSlskdState', () => {
  it('does not treat rejected or errored completed transfers as downloads', () => {
    assert.equal(downloadAttemptStatusFromSlskdState('Completed, Succeeded'), 'downloaded')
    assert.equal(downloadAttemptStatusFromSlskdState('Completed, Rejected'), 'failed')
    assert.equal(downloadAttemptStatusFromSlskdState('Completed, Errored'), 'failed')
    assert.equal(downloadAttemptStatusFromSlskdState('Completed, TimedOut'), 'timeout')
  })
})

describe('wantListStatusAfterAttempt', () => {
  it('keeps a wanted record downloaded when another parallel candidate fails', () => {
    assert.deepEqual(wantListStatusAfterAttempt('timeout', true, 'timed out'), {
      pipelineStatus: 'downloaded',
      pipelineError: null
    })
    assert.deepEqual(wantListStatusAfterAttempt('timeout', false, 'timed out'), {
      pipelineStatus: 'error',
      pipelineError: 'timed out'
    })
  })
})

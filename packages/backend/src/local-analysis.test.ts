import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAudioOnlyFfmpegArgs } from '@djbrain/backend/audio-analysis-service.ts'
import { buildLocalRecordingDecision, LocalRecordingIdentityService } from '@djbrain/backend/local-recording-identity.ts'
import { buildLocalAnalysisTargets, buildSongsOnlySyncPlan } from '@djbrain/backend/local-song-sync.ts'

const tags = {
  artist: 'Daft Punk',
  title: 'One More Time (Short Radio Edit)',
  album: 'Discovery',
  year: '2000',
  label: 'Virgin',
  catalogNumber: null,
  trackPosition: '1',
  discogsReleaseId: null,
  discogsTrackPosition: null
}

describe('buildLocalRecordingDecision', () => {
  it('creates a ready provisional recording from good tags', () => {
    const decision = buildLocalRecordingDecision({
      filename: 'songs/2000/Daft Punk - One More Time.flac',
      audioHash: 'hash-1',
      durationSeconds: 320,
      tags
    })

    assert.equal(decision.status, 'ready')
    assert.equal(decision.assignmentMethod, 'heuristic')
    assert.equal(decision.confidence, 80)
    assert.deepEqual(decision.createRecording?.canonical, {
      artist: 'Daft Punk',
      title: 'One More Time',
      version: 'Short Radio Edit',
      year: '2000'
    })
  })

  it('uses embedded Discogs ids without requiring network lookup', () => {
    const decision = buildLocalRecordingDecision({
      filename: 'songs/2000/Daft Punk - One More Time.flac',
      audioHash: 'hash-1',
      durationSeconds: 320,
      tags: { ...tags, discogsReleaseId: 123, discogsTrackPosition: 'A1' }
    })

    assert.ok(decision.acceptedClaims.some((claim) => claim.externalKey === 'discogs:release:123:track:a1'))
  })

  it('ignores embedded Discogs track positions that conflict with file track tags', () => {
    const decision = buildLocalRecordingDecision({
      filename: 'songs/2002/DJ Mel - Atomik Base.mp3',
      audioHash: 'hash-1',
      durationSeconds: 260,
      tags: { ...tags, artist: 'DJ Mel', title: 'Atomik Base', album: 'Fly', year: null, trackPosition: '02/18', discogsReleaseId: 407430, discogsTrackPosition: 'Z' }
    })

    assert.equal(decision.acceptedClaims.some((claim) => claim.provider === 'discogs'), false)
  })

  it('ignores placeholder Discogs Z track positions without a file track tag', () => {
    const decision = buildLocalRecordingDecision({
      filename: 'songs/2003/Virus Infected - Liquid Attack Vol. 1.mp3',
      audioHash: 'hash-1',
      durationSeconds: 383,
      tags: { ...tags, artist: 'Virus Infected', title: 'Liquid Attack Vol. 1', album: 'Vol. 2 - This Is My Life', year: null, trackPosition: null, discogsReleaseId: 734836, discogsTrackPosition: 'Z' }
    })

    assert.equal(decision.acceptedClaims.some((claim) => claim.provider === 'discogs'), false)
    assert.equal(decision.createRecording?.canonical.title, 'Liquid Attack Vol. 1')
  })

  it('does not attach conflicting source-claim matches to local file evidence', async () => {
    const saved = { decision: null as ReturnType<typeof buildLocalRecordingDecision> | null }
    const service = new LocalRecordingIdentityService({
      collectionService: {
        readFileSnapshot: async () => ({ filesize: 1, mtimeMs: 1 }),
        readStoredAudioHash: async () => 'hash-1',
        findRecordingByAudioHash: async () => ({
          recordingId: 3013,
          canonical: { artist: 'DJ Mel', title: 'Fly', version: null, year: '2002' }
        }),
        findSourceClaimMatches: async (keys: string[]) => [
          keys.includes('discogs:release:407430:track:z') ? {
            claimId: 1,
            recordingId: 3013,
            externalKey: 'discogs:release:407430:track:z',
            confidence: 90,
            canonical: { artist: 'DJ Mel', title: 'Fly', version: null, year: '2002' }
          } : null,
          keys.includes('local:tags:songs/2002/DJ Mel - Atomik Base.mp3') ? {
            claimId: 2,
            recordingId: 3013,
            externalKey: 'local:tags:songs/2002/DJ Mel - Atomik Base.mp3',
            confidence: 80,
            canonical: { artist: 'DJ Mel', title: 'Fly', version: null, year: '2002' }
          } : null
        ].filter(Boolean),
        saveFileTagState: async () => {},
        saveIdentificationDecision: async (_filename: string, decision: ReturnType<typeof buildLocalRecordingDecision>) => {
          saved.decision = decision
        }
      },
      fileAnalysisService: { get: async () => ({ durationSeconds: 260 }) },
      taggerService: { readTags: () => ({ ...tags, artist: 'DJ Mel', title: 'Atomik Base', album: 'Fly', year: null, trackPosition: null, discogsReleaseId: 407430, discogsTrackPosition: 'Z' }) },
      resolveMusicRelativePath: (filename: string) => filename
    } as never)

    const result = await service.analyzeFile('songs/2002/DJ Mel - Atomik Base.mp3')

    assert.equal(result.recordingId, null)
    assert.equal(saved.decision?.createRecording?.canonical.title, 'Atomik Base')
    assert.equal(saved.decision?.acceptedClaims.some((claim) => claim.provider === 'discogs'), false)
    assert.equal(saved.decision?.acceptedClaims.some((claim) => claim.externalKey.startsWith('local:tags:')), true)
  })

  it('falls back to filename inference when tags are absent', () => {
    const decision = buildLocalRecordingDecision({
      filename: 'songs/1998/Xavi Metralla - Metramorphosis (Original Mix).flac',
      audioHash: 'hash-2',
      durationSeconds: 381,
      tags: null
    })

    assert.equal(decision.confidence, 65)
    assert.deepEqual(decision.createRecording?.canonical, {
      artist: 'Xavi Metralla',
      title: 'Metramorphosis',
      version: 'Original Mix',
      year: '1998'
    })
  })

  it('creates a low-confidence basename fallback for unparseable files', () => {
    const decision = buildLocalRecordingDecision({
      filename: 'songs/mystery_file.flac',
      audioHash: null,
      durationSeconds: null,
      tags: null
    })

    assert.equal(decision.confidence, 35)
    assert.deepEqual(decision.createRecording?.canonical, {
      artist: 'Unknown Artist',
      title: 'mystery file',
      version: null,
      year: null
    })
  })

  it('keeps local tag and filename claim keys scoped to the file', () => {
    const left = buildLocalRecordingDecision({ filename: 'songs/a.flac', audioHash: null, durationSeconds: null, tags })
    const right = buildLocalRecordingDecision({ filename: 'songs/b.flac', audioHash: null, durationSeconds: null, tags })
    const leftKeys = left.acceptedClaims.map((claim) => claim.externalKey)
    const rightKeys = right.acceptedClaims.map((claim) => claim.externalKey)

    assert.ok(leftKeys.includes('local:tags:songs/a.flac'))
    assert.ok(rightKeys.includes('local:tags:songs/b.flac'))
    assert.ok(leftKeys.includes('local:filename:songs/a.flac'))
    assert.ok(rightKeys.includes('local:filename:songs/b.flac'))
  })
})

describe('buildSongsOnlySyncPlan', () => {
  it('diffs songs only and leaves download rows alone', () => {
    const plan = buildSongsOnlySyncPlan({
      songsFolderPath: 'songs',
      known: [
        { filename: 'songs/keep.flac', filesize: 1, mtimeMs: 1 },
        { filename: 'songs/change.flac', filesize: 2, mtimeMs: 2 },
        { filename: 'songs/remove.flac', filesize: 3, mtimeMs: 3 },
        { filename: 'soulseek/complete/download.flac', filesize: 4, mtimeMs: 4 }
      ],
      scanned: [
        { filename: 'songs/keep.flac', filesize: 1, mtimeMs: 1 },
        { filename: 'songs/change.flac', filesize: 20, mtimeMs: 20 },
        { filename: 'songs/add.flac', filesize: 5, mtimeMs: 5 }
      ]
    })

    assert.deepEqual(plan.inserted.map((item) => item.filename), ['songs/add.flac'])
    assert.deepEqual(plan.updated.map((item) => item.filename), ['songs/change.flac'])
    assert.deepEqual(plan.deleted, ['songs/remove.flac'])
    assert.equal(plan.unchanged, 1)
  })
})

describe('buildLocalAnalysisTargets', () => {
  it('skips complete files while keeping changed files forced by sync', () => {
    const scanned = [
      { filename: 'songs/done.mp3', filesize: 1, mtimeMs: 1 },
      { filename: 'songs/changed.mp3', filesize: 2, mtimeMs: 2 },
      { filename: 'songs/missing.mp3', filesize: 3, mtimeMs: 3 }
    ]
    const targets = buildLocalAnalysisTargets({
      scanned,
      completeFilenames: new Set(['songs/done.mp3', 'songs/changed.mp3']),
      forceFilenames: new Set(['songs/changed.mp3']),
      limit: null
    })

    assert.deepEqual(targets.map((item) => item.filename), ['songs/changed.mp3', 'songs/missing.mp3'])
  })

  it('limits after complete files are skipped', () => {
    const targets = buildLocalAnalysisTargets({
      scanned: [
        { filename: 'songs/done.mp3', filesize: 1, mtimeMs: 1 },
        { filename: 'songs/a.mp3', filesize: 2, mtimeMs: 2 },
        { filename: 'songs/b.mp3', filesize: 3, mtimeMs: 3 }
      ],
      completeFilenames: new Set(['songs/done.mp3']),
      forceFilenames: new Set(),
      limit: 1
    })

    assert.deepEqual(targets.map((item) => item.filename), ['songs/a.mp3'])
  })

  it('skips unchanged terminal audio errors while still forcing changed files', () => {
    const targets = buildLocalAnalysisTargets({
      scanned: [
        { filename: 'songs/broken.mp3', filesize: 1, mtimeMs: 1 },
        { filename: 'songs/changed-broken.mp3', filesize: 2, mtimeMs: 2 }
      ],
      completeFilenames: new Set(),
      terminalErrorFilenames: new Set(['songs/broken.mp3', 'songs/changed-broken.mp3']),
      forceFilenames: new Set(['songs/changed-broken.mp3']),
      limit: null
    })

    assert.deepEqual(targets.map((item) => item.filename), ['songs/changed-broken.mp3'])
  })
})

describe('buildAudioOnlyFfmpegArgs', () => {
  it('maps only audio for quality filter commands', () => {
    const args = buildAudioOnlyFfmpegArgs('track.mp3', ['-af', 'astats'])

    assert.deepEqual(args.slice(0, 7), ['-hide_banner', '-nostats', '-i', 'track.mp3', '-map', '0:a:0', '-vn'])
    assert.deepEqual(args.slice(-4), ['-af', 'astats', '-f', 'null', '-'].slice(-4))
  })
})

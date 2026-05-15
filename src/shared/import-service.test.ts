import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ImportService } from '../backend/import-service.ts'
import type { AudioTags } from '../backend/tagger-service.ts'
import type { AppSettings } from './api.ts'
import type { DiscogsTrackMatch } from './discogs-match.ts'

const settings = (root: string): AppSettings => ({
  musicFolderPath: root,
  songsFolderPath: 'songs',
  downloadFolderPaths: ['hasoulseek/complete'],
  slskdBaseURL: '',
  slskdApiKey: '',
  discogsUserToken: '',
  grokApiKey: '',
  serperApiKey: '',
  youtubeApiKey: ''
})

const match: DiscogsTrackMatch = {
  releaseId: 2,
  releaseTitle: 'New Release',
  format: null,
  artist: 'New Artist',
  title: 'New Title',
  version: null,
  trackPosition: 'B1',
  year: '1998',
  label: null,
  catalogNumber: null,
  score: 100
}

const oldTags: AudioTags = {
  artist: 'Old Artist',
  title: 'Old Title',
  album: 'Old Album',
  year: '1997',
  label: 'Old Label',
  catalogNumber: 'OLD-1',
  trackPosition: 'A1',
  discogsReleaseId: 1,
  discogsTrackPosition: 'A1'
}

async function withImportService(test: (ctx: {
  root: string
  service: ImportService
  writes: Array<{ filePath: string; tags: AudioTags }>
}) => Promise<void>, options: { readTags?: (filePath: string) => AudioTags | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'djbrain-import-'))
  const writes: Array<{ filePath: string; tags: AudioTags }> = []
  const tagger = {
    supportsFile: (filePath: string) => filePath.toLowerCase().endsWith('.mp3'),
    readTags: options.readTags ?? ((filePath: string) => filePath.includes('Existing.mp3') ? oldTags : null),
    writeTags: async (filePath: string, tags: AudioTags) => {
      writes.push({ filePath, tags })
      return true
    }
  }
  const service = new ImportService({} as never, tagger as never, {} as never, async (_source, target) => {
    await writeFile(target, 'converted-mp3')
  })
  try {
    await test({ root, service, writes })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('ImportService', () => {
  it('converts flac imports to mp3 before writing to songs', async () => {
    await withImportService(async ({ root, service }) => {
      const source = join(root, 'download.flac')
      await writeFile(source, 'flac')

      const result = await service.importFileWithKnownMatch(settings(root), match, source)

      assert.equal(result.status, 'imported')
      assert.equal(result.status === 'imported' ? result.destRelativePath.replaceAll('\\', '/') : '', 'songs/1998/New Artist - New Title.mp3')
      assert.equal(await readFile(join(root, 'songs/1998/New Artist - New Title.mp3'), 'utf8'), 'converted-mp3')
    })
  })

  it('replaces with converted mp3 bytes and preserves existing tags', async () => {
    await withImportService(async ({ root, service, writes }) => {
      const source = join(root, 'download.flac')
      const target = join(root, 'songs/1997/Existing.mp3')
      await writeFile(source, 'flac')
      await mkdir(join(root, 'songs/1997'), { recursive: true })
      await writeFile(target, 'old-mp3')

      const result = await service.importFileWithKnownMatch(settings(root), match, source, null, {
        conflictStrategy: 'replace',
        replaceRelativePath: 'songs/1997/Existing.mp3'
      })

      assert.equal(result.status, 'replaced')
      assert.equal(await readFile(target, 'utf8'), 'converted-mp3')
      assert.equal(await readFile(join(root, '_replaced', new Date().toISOString().slice(0, 10), '1997/Existing.mp3'), 'utf8'), 'old-mp3')
      assert.equal(writes.length, 1)
      assert.equal(writes[0]?.filePath.endsWith('.mp3'), true)
      assert.deepEqual(writes[0]?.tags, oldTags)
    })
  })

  it('keeps the existing folder year when replacement tags read as zero', async () => {
    await withImportService(async ({ root, service, writes }) => {
      const source = join(root, 'download.flac')
      const target = join(root, 'songs/1997/Existing.mp3')
      await writeFile(source, 'flac')
      await mkdir(join(root, 'songs/1997'), { recursive: true })
      await writeFile(target, 'old-mp3')

      const result = await service.importFileWithKnownMatch(settings(root), match, source, null, {
        conflictStrategy: 'replace',
        replaceRelativePath: 'songs/1997/Existing.mp3'
      })

      assert.equal(result.status, 'replaced')
      assert.equal(writes[0]?.tags.year, '1997')
    }, { readTags: (filePath) => filePath.includes('Existing.mp3') ? { ...oldTags, year: '0' } : null })
  })
})

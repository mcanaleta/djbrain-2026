import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { CollectionService } from './collection-service.ts'
import type { AudioAnalysisService } from './audio-analysis-service.ts'
import type { AudioAnalysis } from '../shared/api.ts'

type FileAnalysisServiceDeps = {
  getCollectionService: () => CollectionService
  audioAnalysisService: AudioAnalysisService
}

function hashAudioData(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      '-'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Audio hash timed out.'))
    }, 120000)
    const hash = createHash('sha256')
    let stderr = ''
    child.stdout.on('data', (chunk) => hash.update(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(hash.digest('hex'))
      else reject(new Error(stderr.trim() || `Audio hash failed (${code ?? 'unknown'}).`))
    })
  })
}

export class FileAnalysisService {
  private readonly deps: FileAnalysisServiceDeps

  private readonly hashCache = new Map<string, Promise<string>>()

  constructor(deps: FileAnalysisServiceDeps) {
    this.deps = deps
  }

  async get(filename: string, absolutePath: string): Promise<AudioAnalysis | null> {
    const collectionService = this.deps.getCollectionService()
    const snapshot = await collectionService.readFileSnapshot(filename)
    if (!snapshot) return this.deps.audioAnalysisService.analyze(absolutePath).catch(() => null)
    try {
      const audioHash = await this.getAudioHash(filename, absolutePath, snapshot.filesize, snapshot.mtimeMs)
      const cached = await collectionService.readStoredAudioAnalysis(audioHash)
      if (cached) return JSON.parse(cached) as AudioAnalysis
      const analysis = await this.deps.audioAnalysisService.analyze(absolutePath)
      await collectionService.saveStoredAudioAnalysis(audioHash, JSON.stringify(analysis))
      return analysis
    } catch {
      return null
    }
  }

  private async getAudioHash(filename: string, absolutePath: string, filesize: number, mtimeMs: number): Promise<string> {
    const collectionService = this.deps.getCollectionService()
    const cached = await collectionService.readStoredAudioHash(filename)
    if (cached) return cached
    const cacheKey = `${filename}:${filesize}:${mtimeMs}`
    const pending = this.hashCache.get(cacheKey)
    if (pending) return pending
    const created = hashAudioData(absolutePath)
      .then(async (audioHash) => {
        this.hashCache.delete(cacheKey)
        await collectionService.saveStoredAudioHash(filename, { filesize, mtimeMs, audioHash })
        return audioHash
      })
      .catch(async (error) => {
        this.hashCache.delete(cacheKey)
        await collectionService.saveStoredAudioHashError(filename, {
          filesize,
          mtimeMs,
          errorMessage: error instanceof Error ? error.message : 'Audio hash failed.'
        })
        throw error
      })
    this.hashCache.set(cacheKey, created)
    return created
  }
}

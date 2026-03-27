import { basename } from 'node:path'
import type { CollectionService } from './collection-service.ts'
import type { FileAnalysisService } from './file-analysis-service.ts'
import type { ImportProcessingQueue } from './import-processing-queue.ts'
import type { AppSettings } from './settings-store.ts'
import type { ImportReviewService } from './import-review-service.ts'
import { parseSongFilename } from './import-service.ts'
import { parseImportFilename } from '../shared/import-filename.ts'

type ImportReviewBackgroundServiceDeps = {
  collectionService: CollectionService
  fileAnalysisService: FileAnalysisService
  importReviewService: ImportReviewService
  queue: ImportProcessingQueue
  resolveMusicRelativePath: (filename: string) => string
  getSettings: () => AppSettings
}

export class ImportReviewBackgroundService {
  private running = false

  private readonly deps: ImportReviewBackgroundServiceDeps

  constructor(deps: ImportReviewBackgroundServiceDeps) {
    this.deps = deps
  }

  start(): void {
    this.deps.collectionService.resetImportReviewProcessing()
    void this.syncQueue()
  }

  kick(): void {
    if (this.running) return
    void this.run()
  }

  async syncQueue(): Promise<number> {
    const queued = await this.deps.queue.enqueue(this.deps.collectionService.listPendingImportReviewFilenames())
    if (queued > 0) this.kick()
    return queued
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const filename = await this.deps.queue.take(1)
        if (!filename) return
        const next = this.deps.collectionService.claimImportReviewFile(filename)
        if (!next) continue
        await this.process(next)
      }
    } finally {
      this.running = false
      if (this.deps.collectionService.getStatus().importPendingCount) void this.syncQueue()
    }
  }

  private async process(next: {
    filename: string
    filesize: number
    mtimeMs: number
    parsedArtist: string | null
    parsedTitle: string | null
    parsedVersion: string | null
  }): Promise<void> {
    const absolutePath = this.deps.resolveMusicRelativePath(next.filename)
    const preprocessed = parseImportFilename(next.filename)
    const parsed =
      parseSongFilename(basename(next.filename)) ??
      (next.parsedTitle
        ? { artist: next.parsedArtist ?? '', title: next.parsedTitle, version: next.parsedVersion ?? null }
        : null)
    if (!parsed) {
      this.deps.collectionService.saveImportReviewError(next.filename, {
        filesize: next.filesize,
        mtimeMs: next.mtimeMs,
        parsedArtist: next.parsedArtist,
        parsedTitle: next.parsedTitle,
        parsedVersion: next.parsedVersion,
        parsedYear: preprocessed?.year ?? null,
        errorMessage: `Cannot parse filename: ${basename(next.filename)}`
      })
      return
    }
    try {
      const sourceAnalysis = await this.deps.fileAnalysisService.get(next.filename, absolutePath)
      const review = await this.deps.importReviewService.build({
        filename: next.filename,
        absolutePath,
        parsed,
        settings: this.deps.getSettings(),
        sourceAnalysis
      })
      this.deps.collectionService.saveImportReviewCache(next.filename, {
        filesize: next.filesize,
        mtimeMs: next.mtimeMs,
        parsedArtist: review.parsed?.artist ?? next.parsedArtist,
        parsedTitle: review.parsed?.title ?? next.parsedTitle,
        parsedVersion: review.parsed?.version ?? next.parsedVersion,
        parsedYear: preprocessed?.year ?? null,
        reviewJson: JSON.stringify({ ...review, sourceAnalysis: null })
      })
    } catch (error) {
      this.deps.collectionService.saveImportReviewError(next.filename, {
        filesize: next.filesize,
        mtimeMs: next.mtimeMs,
        parsedArtist: next.parsedArtist,
        parsedTitle: next.parsedTitle,
        parsedVersion: next.parsedVersion,
        parsedYear: preprocessed?.year ?? null,
        errorMessage: error instanceof Error ? error.message : 'Import preprocessing failed.'
      })
    }
  }
}

import type { CollectionService } from './collection-service.ts'
import type { ImportProcessingQueue } from './import-processing-queue.ts'
import type { RecordingIdentityService } from './recording-identity-service.ts'

type IdentificationBackgroundServiceDeps = {
  collectionService: CollectionService
  identityService: RecordingIdentityService
  queue: ImportProcessingQueue
}

export class IdentificationBackgroundService {
  private running = false

  private readonly deps: IdentificationBackgroundServiceDeps

  constructor(deps: IdentificationBackgroundServiceDeps) {
    this.deps = deps
  }

  start(): void {
    void (async () => {
      await this.deps.collectionService.resetIdentificationProcessing()
      await this.deps.collectionService.queueIdentificationFiles([], false)
      await this.syncQueue()
    })()
  }

  kick(): void {
    if (this.running) return
    void this.run()
  }

  async syncQueue(): Promise<number> {
    const queued = await this.deps.queue.enqueue(await this.deps.collectionService.listPendingIdentificationFilenames())
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
        const next = await this.deps.collectionService.claimIdentificationFile(filename)
        if (!next) continue
        try {
          const decision = await this.deps.identityService.identifyFile(next.filename)
          await this.deps.collectionService.saveIdentificationDecision(next.filename, {
            filesize: next.filesize,
            mtimeMs: next.mtimeMs,
            ...decision
          })
        } catch (error) {
          await this.deps.collectionService.saveIdentificationError(next.filename, {
            filesize: next.filesize,
            mtimeMs: next.mtimeMs,
            errorMessage: error instanceof Error ? error.message : 'Identification failed.'
          })
        }
      }
    } finally {
      this.running = false
      if (this.deps.collectionService.getStatus().identificationPendingCount) {
        void this.syncQueue()
      }
    }
  }
}

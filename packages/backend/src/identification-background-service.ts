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
    void this.processAvailable()
  }

  async syncQueue(kick: boolean = true): Promise<number> {
    const queued = await this.deps.queue.enqueue(await this.deps.collectionService.listPendingIdentificationFilenames())
    if (queued > 0 && kick) this.kick()
    return queued
  }

  async processAvailable(limit: number = Number.POSITIVE_INFINITY, reschedule: boolean = true): Promise<number> {
    if (this.running) return 0
    this.running = true
    let processed = 0
    try {
      while (processed < limit) {
        const filename = await this.deps.queue.take(1)
        if (!filename) return processed
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
        processed += 1
      }
      return processed
    } finally {
      this.running = false
      if (reschedule && this.deps.collectionService.getStatus().identificationPendingCount) {
        void this.syncQueue()
      }
    }
  }
}

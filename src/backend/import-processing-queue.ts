import { createClient } from 'redis'

export type ImportProcessingQueueStats = {
  backend: 'redis' | 'memory'
  depth: number
}

export class ImportProcessingQueue {
  private client: ReturnType<typeof createClient> | null = null

  private readonly memoryQueue: string[] = []

  private readonly memoryQueued = new Set<string>()

  private readonly redisUrl: string | null

  private readonly keyPrefix: string

  constructor(redisUrl: string | null, keyPrefix: string = 'djbrain:import-processing') {
    this.redisUrl = redisUrl
    this.keyPrefix = keyPrefix
  }

  async start(): Promise<void> {
    if (!this.redisUrl) return
    try {
      const client = createClient({ url: this.redisUrl })
      client.on('error', () => {})
      await client.connect()
      this.client = client
    } catch {
      this.client = null
    }
  }

  async stop(): Promise<void> {
    if (!this.client) return
    await this.client.quit().catch(() => {})
    this.client = null
  }

  async enqueue(filenames: string[]): Promise<number> {
    const unique = [...new Set(filenames.filter(Boolean))]
    if (!this.client) return this.enqueueMemory(unique)
    const multi = this.client.multi()
    for (const filename of unique) multi.sAdd(this.queuedKey, filename)
    const added = (await multi.exec()).map((value) => Number(value) || 0)
    const ready = unique.filter((_, index) => added[index] > 0)
    if (ready.length > 0) await this.client.rPush(this.queueKey, ready)
    return ready.length
  }

  async take(timeoutSeconds: number = 1): Promise<string | null> {
    if (!this.client) return this.takeMemory()
    const result = await this.client.brPop(this.queueKey, timeoutSeconds)
    if (!result?.element) return null
    await this.client.sRem(this.queuedKey, result.element)
    return result.element
  }

  async getStats(): Promise<ImportProcessingQueueStats> {
    if (!this.client) return { backend: 'memory', depth: this.memoryQueue.length }
    return { backend: 'redis', depth: await this.client.lLen(this.queueKey) }
  }

  private enqueueMemory(filenames: string[]): number {
    let added = 0
    for (const filename of filenames) {
      if (this.memoryQueued.has(filename)) continue
      this.memoryQueued.add(filename)
      this.memoryQueue.push(filename)
      added += 1
    }
    return added
  }

  private takeMemory(): string | null {
    const filename = this.memoryQueue.shift() ?? null
    if (filename) this.memoryQueued.delete(filename)
    return filename
  }

  private get queueKey(): string {
    return `${this.keyPrefix}:queue`
  }

  private get queuedKey(): string {
    return `${this.keyPrefix}:queued`
  }
}

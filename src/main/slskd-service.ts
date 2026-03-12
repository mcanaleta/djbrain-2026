import type { AppSettings } from './settings-store'

// ─── Slskd API types ──────────────────────────────────────────────────────────

type SlskdFileAttribute = {
  attribute: string
  value: number
}

type SlskdFile = {
  filename: string
  size: number
  attributes?: SlskdFileAttribute[]
}

type SlskdSearchResponse = {
  username: string
  files: SlskdFile[]
}

type SlskdSearch = {
  id: string
  searchText: string
  state: string // "InProgress" | "Completed" | "Cancelled"
  responses: SlskdSearchResponse[]
}

type SlskdDownloadFile = {
  id: string
  username: string
  filename: string
  size: number
  bytesTransferred: number
  state: string
  percentComplete: number
}

type SlskdUserDownloads = {
  username: string
  directories: Array<{
    directory: string
    files: SlskdDownloadFile[]
  }>
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type SlskdCandidate = {
  username: string
  filename: string
  size: number
  score: number
  bitrate: number | null
  extension: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SlskdService {
  private async fetch<T>(
    settings: AppSettings,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const baseURL = normalizeBaseURL(settings.slskdBaseURL)
    if (!baseURL) throw new Error('slskd Base URL is not configured')
    if (!settings.slskdApiKey) throw new Error('slskd API key is not configured')

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-API-Key': settings.slskdApiKey,
      Authorization: `Bearer ${settings.slskdApiKey}`
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(`${baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `slskd ${method} ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`
      )
    }

    const text = await response.text()
    return text ? (JSON.parse(text) as T) : (undefined as T)
  }

  buildSearchQuery(artist: string, title: string, version: string | null): string {
    const parts = [artist, title].filter((p) => p.trim())
    if (version?.trim()) parts.push(version.trim())
    return parts.join(' ')
  }

  async startSearch(settings: AppSettings, query: string): Promise<string> {
    console.log('[slskd] starting search:', JSON.stringify(query))
    const result = await this.fetch<{ id: string }>(settings, 'POST', '/api/v0/searches', {
      searchText: query
    })
    console.log('[slskd] search started, id:', result.id)
    return result.id
  }

  private async getSearch(settings: AppSettings, searchId: string): Promise<SlskdSearch> {
    return this.fetch<SlskdSearch>(settings, 'GET', `/api/v0/searches/${searchId}`)
  }

  async deleteSearch(settings: AppSettings, searchId: string): Promise<void> {
    await this.fetch<void>(settings, 'DELETE', `/api/v0/searches/${searchId}`)
  }

  async waitForResults(
    settings: AppSettings,
    searchId: string,
    timeoutMs = 60_000
  ): Promise<SlskdSearch> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const raw = await this.fetch<Record<string, unknown>>(
        settings,
        'GET',
        `/api/v0/searches/${searchId}`
      )
      const responseCount = Array.isArray(raw['responses']) ? raw['responses'].length : 0
      const fileCount = Array.isArray(raw['responses'])
        ? (raw['responses'] as SlskdSearchResponse[]).reduce(
            (n, r) => n + (r.files?.length ?? 0),
            0
          )
        : 0
      console.log(
        `[slskd] poll ${searchId}: state=${raw['state']} responses=${responseCount} files=${fileCount} keys=${Object.keys(raw).join(',')}`
      )
      if (raw['state'] !== 'InProgress') {
        console.log('[slskd] search done, raw snippet:', JSON.stringify(raw).slice(0, 800))
        return raw as unknown as SlskdSearch
      }
      await sleep(2_500)
    }
    console.log(`[slskd] search ${searchId} timed out, returning partial results`)
    const raw = await this.fetch<Record<string, unknown>>(
      settings,
      'GET',
      `/api/v0/searches/${searchId}`
    )
    console.log('[slskd] timeout final raw snippet:', JSON.stringify(raw).slice(0, 800))
    return raw as unknown as SlskdSearch
  }

  scoreFile(
    artist: string,
    title: string,
    version: string | null,
    file: SlskdFile,
    username: string
  ): SlskdCandidate {
    const parts = file.filename.replace(/\\/g, '/').split('/')
    const basename = parts[parts.length - 1] ?? file.filename
    const dotIdx = basename.lastIndexOf('.')
    const ext = dotIdx >= 0 ? basename.slice(dotIdx + 1).toLowerCase() : ''
    const stem = (dotIdx >= 0 ? basename.slice(0, dotIdx) : basename).toLowerCase()

    const normStem = norm(stem)
    const normArtist = norm(artist)
    const normTitle = norm(title)

    let score = 0

    // Artist + title match in filename
    const hasArtist = normStem.includes(normArtist)
    const hasTitle = normStem.includes(normTitle)
    if (hasArtist && hasTitle) score += 50
    else if (hasTitle) score += 25
    else if (hasArtist) score += 10

    // Version match
    if (version) {
      if (normStem.includes(norm(version))) score += 15
    }

    // Format quality
    if (['flac', 'wav', 'aiff', 'aif', 'alac'].includes(ext)) score += 25
    else if (ext === 'mp3') score += 10
    else if (['m4a', 'ogg', 'opus'].includes(ext)) score += 5
    else score -= 10

    // Reasonable file size (2 MB – 500 MB)
    if (file.size >= 2_000_000 && file.size <= 500_000_000) score += 5

    const bitrateAttr = file.attributes?.find((a) => a.attribute === 'BitRate')
    const bitrate = bitrateAttr ? bitrateAttr.value : null

    // High bitrate bonus
    if (bitrate && bitrate >= 320) score += 5

    return {
      username,
      filename: file.filename,
      size: file.size,
      score: Math.max(0, score),
      bitrate,
      extension: ext
    }
  }

  extractCandidates(
    artist: string,
    title: string,
    version: string | null,
    search: SlskdSearch
  ): SlskdCandidate[] {
    const candidates: SlskdCandidate[] = []
    for (const response of search.responses ?? []) {
      for (const file of response.files ?? []) {
        candidates.push(this.scoreFile(artist, title, version, file, response.username))
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const top = candidates.slice(0, 30)
    console.log(
      `[slskd] scored ${candidates.length} files, top 3:`,
      top.slice(0, 3).map((c) => `score=${c.score} ext=${c.extension} user=${c.username}`)
    )
    return top
  }

  async downloadFile(
    settings: AppSettings,
    username: string,
    filename: string,
    size: number
  ): Promise<void> {
    console.log(`[slskd] requesting download from ${username}: ${filename} (${size} bytes)`)
    await this.fetch<void>(
      settings,
      'POST',
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}`,
      [{ filename, size }]
    )
    console.log(`[slskd] download request accepted`)
  }

  async getDownloadState(
    settings: AppSettings,
    username: string,
    filename: string
  ): Promise<string | null> {
    try {
      const result = await this.fetch<SlskdUserDownloads>(
        settings,
        'GET',
        `/api/v0/transfers/downloads/${encodeURIComponent(username)}`
      )
      for (const dir of result.directories ?? []) {
        for (const file of dir.files ?? []) {
          if (file.filename === filename) return file.state
        }
      }
      return null
    } catch {
      return null
    }
  }

  async waitForDownload(
    settings: AppSettings,
    username: string,
    filename: string,
    timeoutMs = 600_000 // 10 minutes
  ): Promise<'Completed' | 'Failed' | 'Timeout'> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(5_000)
      const state = await this.getDownloadState(settings, username, filename)
      if (state === 'Completed') return 'Completed'
      if (state === null || ['Cancelled', 'TimedOut', 'Errored', 'Rejected'].includes(state ?? ''))
        return 'Failed'
    }
    return 'Timeout'
  }
}

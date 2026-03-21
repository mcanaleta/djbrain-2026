import type {
  ImportFileResult,
  DJBrainApi,
  SettingsPatch,
  SlskdConnectionTestInput,
  WantListAddInput,
  WantListItem,
  CollectionSyncStatus
} from '../../../shared/api'
import type { DiscogsEntityType } from '../../../shared/discogs'
import type { OnlineSearchScope } from '../../../shared/online-search'

const JSON_HEADERS = {
  'Content-Type': 'application/json'
}

const wantListListeners = new Set<(item: WantListItem) => void>()
const collectionListeners = new Set<(status: CollectionSyncStatus) => void>()

let wantListPollTimer: number | null = null
let collectionPollTimer: number | null = null
let lastWantListSnapshot = new Map<number, string>()
let lastCollectionSnapshot = ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as T | { message?: string }) : undefined

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && payload !== null && 'message' in payload
        ? payload.message
        : response.statusText
    throw new Error(typeof message === 'string' && message ? message : `Request failed (${response.status})`)
  }

  return payload as T
}

function emitWantListItem(item: WantListItem): void {
  for (const listener of wantListListeners) {
    listener(item)
  }
}

function emitCollectionStatus(status: CollectionSyncStatus): void {
  for (const listener of collectionListeners) {
    listener(status)
  }
}

async function syncWantListSnapshot(): Promise<void> {
  if (wantListListeners.size === 0) return
  const items = await request<WantListItem[]>('/api/want-list')
  const nextSnapshot = new Map<number, string>()

  for (const item of items) {
    const serialized = JSON.stringify(item)
    nextSnapshot.set(item.id, serialized)
    if (lastWantListSnapshot.get(item.id) !== serialized) {
      emitWantListItem(item)
    }
  }

  lastWantListSnapshot = nextSnapshot
}

async function syncCollectionSnapshot(): Promise<void> {
  if (collectionListeners.size === 0) return
  const status = await request<CollectionSyncStatus>('/api/collection/status')
  const serialized = JSON.stringify(status)
  if (serialized !== lastCollectionSnapshot) {
    lastCollectionSnapshot = serialized
    emitCollectionStatus(status)
  }
}

function ensureWantListPolling(): void {
  if (wantListPollTimer !== null || wantListListeners.size === 0) return
  void syncWantListSnapshot()
  wantListPollTimer = window.setInterval(() => {
    void syncWantListSnapshot()
  }, 2000)
}

function ensureCollectionPolling(): void {
  if (collectionPollTimer !== null || collectionListeners.size === 0) return
  void syncCollectionSnapshot()
  collectionPollTimer = window.setInterval(() => {
    void syncCollectionSnapshot()
  }, 2000)
}

function stopWantListPolling(): void {
  if (wantListListeners.size > 0 || wantListPollTimer === null) return
  window.clearInterval(wantListPollTimer)
  wantListPollTimer = null
}

function stopCollectionPolling(): void {
  if (collectionListeners.size > 0 || collectionPollTimer === null) return
  window.clearInterval(collectionPollTimer)
  collectionPollTimer = null
}

const browserApi: DJBrainApi = {
  wantList: {
    list: () => request('/api/want-list'),
    get: (id: number) => request<WantListItem | null>(`/api/want-list/${id}`),
    async add(input: WantListAddInput) {
      const item = await request<WantListItem>('/api/want-list', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input)
      })
      emitWantListItem(item)
      return item
    },
    async update(id: number, input: WantListAddInput) {
      const item = await request<WantListItem | null>(`/api/want-list/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(input)
      })
      if (item) emitWantListItem(item)
      return item
    },
    async remove(id: number) {
      await request<void>(`/api/want-list/${id}`, {
        method: 'DELETE',
        headers: JSON_HEADERS
      })
      lastWantListSnapshot.delete(id)
    },
    async search(id: number, query?: string) {
      const item = await request<WantListItem | null>(`/api/want-list/${id}/search`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(query && query.trim() ? { query } : {})
      })
      if (item) emitWantListItem(item)
      return item
    },
    getCandidates: (id: number) => request(`/api/want-list/${id}/candidates`),
    async download(id: number, username: string, filename: string, size: number) {
      const item = await request<WantListItem | null>(`/api/want-list/${id}/download`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ username, filename, size })
      })
      if (item) emitWantListItem(item)
    },
    async import(id: number, localFilePath: string) {
      const item = await request<WantListItem | null>(`/api/want-list/${id}/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ localFilePath, filename: localFilePath })
      })
      if (item) emitWantListItem(item)
    },
    async resetPipeline(id: number) {
      const item = await request<WantListItem | null>(`/api/want-list/${id}/reset`, {
        method: 'POST'
      })
      if (item) emitWantListItem(item)
      return item
    },
    onItemUpdated(listener) {
      wantListListeners.add(listener)
      ensureWantListPolling()
      return () => {
        wantListListeners.delete(listener)
        stopWantListPolling()
      }
    }
  },
  settings: {
    get: () => request('/api/settings'),
    update: (patch: SettingsPatch) =>
      request('/api/settings', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch)
      }),
    async pickDirectory(options) {
      const promptText = options?.title ?? 'Enter an absolute folder path'
      const defaultValue = options?.defaultPath ?? ''
      return window.prompt(promptText, defaultValue)?.trim() || null
    }
  },
  slskd: {
    testConnection: (input: SlskdConnectionTestInput) =>
      request('/api/slskd/test-connection', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input)
      })
  },
  onlineSearch: {
    search: (query: string, scope?: OnlineSearchScope) =>
      request(
        `/api/online-search?query=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope ?? 'online')}`
      ),
    getDiscogsEntity: (type: DiscogsEntityType, id: number | string) =>
      request(`/api/discogs/${type}/${id}`)
  },
  youtube: {
    search: (query: string) => request(`/api/youtube-search?query=${encodeURIComponent(query)}`)
  },
  youtubeApi: {
    search: (query: string) => request(`/api/youtube-api/search?query=${encodeURIComponent(query)}`)
  },
  grokSearch: {
    search: (query: string) => request(`/api/grok-search?query=${encodeURIComponent(query)}`)
  },
  collection: {
    list: (query?: string) => request(`/api/collection?query=${encodeURIComponent(query ?? '')}`),
    listDownloads: (query?: string) =>
      request(`/api/collection/downloads?query=${encodeURIComponent(query ?? '')}`),
    async syncNow() {
      const status = await request<CollectionSyncStatus>('/api/collection/sync', { method: 'POST' })
      emitCollectionStatus(status)
      return status
    },
    async getStatus() {
      const status = await request<CollectionSyncStatus>('/api/collection/status')
      lastCollectionSnapshot = JSON.stringify(status)
      return status
    },
    onUpdated(listener) {
      collectionListeners.add(listener)
      ensureCollectionPolling()
      return () => {
        collectionListeners.delete(listener)
        stopCollectionPolling()
      }
    },
    async importFile(filename: string) {
      const result = await request<ImportFileResult>(`/api/collection/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ filename })
      })
      void syncCollectionSnapshot()
      return result
    },
    async deleteFile(filename: string) {
      await request<void>('/api/collection/file', {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: JSON.stringify({ filename })
      })
      void syncCollectionSnapshot()
    },
    async clearEmptyFolders() {
      const result = await request<{ count: number }>('/api/collection/clear-empty-folders', {
        method: 'POST'
      })
      void syncCollectionSnapshot()
      return result.count
    },
    showInFinder: (filename: string) =>
      request<void>('/api/collection/show-in-finder', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ filename })
      }),
    openInPlayer: (filename: string) =>
      request<void>('/api/collection/open-in-player', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ filename })
      })
  }
}

export function installBrowserApi(): void {
  if (typeof window === 'undefined') return
  if (window.api) return
  window.api = browserApi
}

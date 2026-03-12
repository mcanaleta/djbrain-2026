import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DiscogsEntityDetail, DiscogsEntityType } from '../shared/discogs'
import type { GrokSearchResponse } from '../shared/grok-search'
import type { OnlineSearchResponse, OnlineSearchScope } from '../shared/online-search'

export type AppSettings = {
  musicFolderPath: string
  songsFolderPath: string
  downloadFolderPaths: string[]
  slskdBaseURL: string
  slskdApiKey: string
  discogsUserToken: string
  grokApiKey: string
  serperApiKey: string
}

export type AppPaths = {
  userDataPath: string
  settingsFilePath: string
  dataDirPath: string
  databaseFilePath: string
  cacheDirPath: string
  logsDirPath: string
}

export type SettingsSnapshot = {
  settings: AppSettings
  appPaths: AppPaths
}

export type SettingsPatch = Partial<AppSettings>

type PickDirectoryOptions = {
  title?: string
  defaultPath?: string
}

export type CollectionItem = {
  filename: string
  filesize: number
}

export type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

export type CollectionListResult = {
  items: CollectionItem[]
  total: number
}

export type WantListPipelineStatus =
  | 'idle'
  | 'searching'
  | 'results_ready'
  | 'no_results'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type WantListItem = {
  id: number
  artist: string
  title: string
  version: string | null
  length: string | null
  album: string | null
  label: string | null
  addedAt: string
  pipelineStatus: WantListPipelineStatus
  searchId: string | null
  searchResultCount: number
  bestCandidatesJson: string | null
  downloadUsername: string | null
  downloadFilename: string | null
  pipelineError: string | null
}

export type WantListAddInput = {
  artist: string
  title: string
  version?: string | null
  length?: string | null
  album?: string | null
  label?: string | null
}

export type SlskdCandidate = {
  username: string
  filename: string
  size: number
  score: number
  bitrate: number | null
  extension: string
}

export type SlskdConnectionTestInput = {
  baseURL: string
  apiKey: string
}

export type SlskdConnectionTestResult = {
  ok: boolean
  status: number | null
  endpoint: string | null
  message: string
}

export type DJBrainApi = {
  wantList: {
    list: () => Promise<WantListItem[]>
    add: (input: WantListAddInput) => Promise<WantListItem>
    update: (id: number, input: WantListAddInput) => Promise<WantListItem | null>
    remove: (id: number) => Promise<void>
    search: (id: number) => Promise<WantListItem | null>
    getCandidates: (id: number) => Promise<SlskdCandidate[]>
    download: (id: number, username: string, filename: string, size: number) => Promise<void>
    resetPipeline: (id: number) => Promise<WantListItem | null>
    onItemUpdated: (listener: (item: WantListItem) => void) => () => void
  }
  settings: {
    get: () => Promise<SettingsSnapshot>
    update: (patch: SettingsPatch) => Promise<SettingsSnapshot>
    pickDirectory: (options?: PickDirectoryOptions) => Promise<string | null>
  }
  slskd: {
    testConnection: (input: SlskdConnectionTestInput) => Promise<SlskdConnectionTestResult>
  }
  onlineSearch: {
    search: (query: string, scope?: OnlineSearchScope) => Promise<OnlineSearchResponse>
    getDiscogsEntity: (
      type: DiscogsEntityType,
      id: number | string
    ) => Promise<DiscogsEntityDetail>
  }
  grokSearch: {
    search: (query: string) => Promise<GrokSearchResponse>
  }
  collection: {
    list: (query?: string) => Promise<CollectionListResult>
    listDownloads: (query?: string) => Promise<CollectionListResult>
    syncNow: () => Promise<CollectionSyncStatus>
    getStatus: () => Promise<CollectionSyncStatus>
    onUpdated: (listener: (status: CollectionSyncStatus) => void) => () => void
  }
}

const api: DJBrainApi = {
  wantList: {
    list: () => ipcRenderer.invoke('want-list:list'),
    add: (input) => ipcRenderer.invoke('want-list:add', input),
    update: (id, input) => ipcRenderer.invoke('want-list:update', id, input),
    remove: (id) => ipcRenderer.invoke('want-list:remove', id),
    search: (id) => ipcRenderer.invoke('want-list:search', id),
    getCandidates: (id) => ipcRenderer.invoke('want-list:get-candidates', id),
    download: (id, username, filename, size) =>
      ipcRenderer.invoke('want-list:download', id, username, filename, size),
    resetPipeline: (id) => ipcRenderer.invoke('want-list:reset-pipeline', id),
    onItemUpdated: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, item: WantListItem): void => {
        listener(item)
      }
      ipcRenderer.on('want-list:item-updated', wrapped)
      return () => {
        ipcRenderer.off('want-list:item-updated', wrapped)
      }
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    pickDirectory: (options) => ipcRenderer.invoke('settings:pick-directory', options ?? {})
  },
  slskd: {
    testConnection: (input) => ipcRenderer.invoke('slskd:test-connection', input)
  },
  onlineSearch: {
    search: (query, scope) => ipcRenderer.invoke('online-search:search', query, scope ?? 'online'),
    getDiscogsEntity: (type, id) =>
      ipcRenderer.invoke('online-search:get-discogs-entity', type, id)
  },
  grokSearch: {
    search: (query) => ipcRenderer.invoke('grok-search:search', query)
  },
  collection: {
    list: (query) => ipcRenderer.invoke('collection:list', query ?? ''),
    listDownloads: (query) => ipcRenderer.invoke('collection:list-downloads', query ?? ''),
    syncNow: () => ipcRenderer.invoke('collection:sync-now'),
    getStatus: () => ipcRenderer.invoke('collection:get-status'),
    onUpdated: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: CollectionSyncStatus): void => {
        listener(status)
      }
      ipcRenderer.on('collection:updated', wrapped)
      return () => {
        ipcRenderer.off('collection:updated', wrapped)
      }
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

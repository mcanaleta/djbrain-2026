import { ElectronAPI } from '@electron-toolkit/preload'
import type { DiscogsEntityDetail, DiscogsEntityType } from '../shared/discogs'
import type { GrokSearchResponse } from '../shared/grok-search'
import type { OnlineSearchResponse, OnlineSearchScope } from '../shared/online-search'

type AppSettings = {
  musicFolderPath: string
  songsFolderPath: string
  downloadFolderPaths: string[]
  slskdBaseURL: string
  slskdApiKey: string
  discogsUserToken: string
  grokApiKey: string
  serperApiKey: string
}

type AppPaths = {
  userDataPath: string
  settingsFilePath: string
  dataDirPath: string
  databaseFilePath: string
  cacheDirPath: string
  logsDirPath: string
}

type SettingsSnapshot = {
  settings: AppSettings
  appPaths: AppPaths
}

type SettingsPatch = Partial<AppSettings>

type PickDirectoryOptions = {
  title?: string
  defaultPath?: string
}

type CollectionItem = {
  filename: string
  filesize: number
}

type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
}

type CollectionListResult = {
  items: CollectionItem[]
  total: number
}

type SlskdConnectionTestInput = {
  baseURL: string
  apiKey: string
}

type SlskdConnectionTestResult = {
  ok: boolean
  status: number | null
  endpoint: string | null
  message: string
}

type DJBrainApi = {
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

declare global {
  interface Window {
    electron: ElectronAPI
    api: DJBrainApi
  }
}

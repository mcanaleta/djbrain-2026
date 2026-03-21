import type { DiscogsArtist, DiscogsLabel, DiscogsMaster, DiscogsRelease } from './discogs'
import type { GrokSearchResponse } from './grok-search'
import type { OnlineSearchResponse, OnlineSearchScope } from './online-search'

export type AppSettings = {
  musicFolderPath: string
  songsFolderPath: string
  downloadFolderPaths: string[]
  slskdBaseURL: string
  slskdApiKey: string
  discogsUserToken: string
  grokApiKey: string
  serperApiKey: string
  youtubeApiKey: string
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

export type PickDirectoryOptions = {
  title?: string
  defaultPath?: string
}

export type CollectionItem = {
  filename: string
  filesize: number
  duration: number | null
  score: number | null
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
  | 'identifying'
  | 'needs_review'
  | 'importing'
  | 'imported'
  | 'import_error'
  | 'error'

export type WantListItem = {
  id: number
  artist: string
  title: string
  version: string | null
  length: string | null
  year: string | null
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
  discogsReleaseId: number | null
  discogsTrackPosition: string | null
  discogsEntityType: string | null
  importedFilename: string | null
}

export type WantListAddInput = {
  artist: string
  title: string
  version?: string | null
  length?: string | null
  year?: string | null
  album?: string | null
  label?: string | null
  discogsReleaseId?: number | null
  discogsTrackPosition?: string | null
  discogsEntityType?: string | null
}

export type SlskdCandidate = {
  username: string
  filename: string
  size: number
  score: number
  bitrate: number | null
  queueLength: number | null
  hasFreeUploadSlot: boolean | null
  uploadSpeed: number | null
  isLocked: boolean
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

export type ImportFileResult =
  | { status: 'imported'; destRelativePath: string }
  | { status: 'imported_upgrade'; destRelativePath: string; existingRelativePath: string }
  | { status: 'skipped_existing'; existingRelativePath: string }
  | { status: 'needs_review' }
  | { status: 'error'; message: string }

export type DJBrainApi = {
  wantList: {
    list: () => Promise<WantListItem[]>
    get: (id: number) => Promise<WantListItem | null>
    add: (input: WantListAddInput) => Promise<WantListItem>
    update: (id: number, input: WantListAddInput) => Promise<WantListItem | null>
    remove: (id: number) => Promise<void>
    search: (id: number, query?: string) => Promise<WantListItem | null>
    getCandidates: (id: number) => Promise<SlskdCandidate[]>
    download: (id: number, username: string, filename: string, size: number) => Promise<void>
    import: (id: number, localFilePath: string) => Promise<void>
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
    getDiscogsEntity: {
      (type: 'release', id: number | string): Promise<DiscogsRelease>
      (type: 'artist', id: number | string): Promise<DiscogsArtist>
      (type: 'label', id: number | string): Promise<DiscogsLabel>
      (type: 'master', id: number | string): Promise<DiscogsMaster>
    }
  }
  youtube: {
    search: (query: string) => Promise<OnlineSearchResponse>
  }
  youtubeApi: {
    search: (query: string) => Promise<OnlineSearchResponse>
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
    importFile: (filename: string) => Promise<ImportFileResult>
    deleteFile: (filename: string) => Promise<void>
    clearEmptyFolders: () => Promise<number>
    showInFinder: (filename: string) => Promise<void>
    openInPlayer: (filename: string) => Promise<void>
  }
}

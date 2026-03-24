import type { DiscogsArtist, DiscogsLabel, DiscogsMaster, DiscogsRelease } from './discogs'
import type { DiscogsTrackMatch } from './discogs-match'
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
  | { status: 'replaced'; replacedRelativePath: string }
  | { status: 'skipped_existing'; existingRelativePath: string }
  | { status: 'needs_review' }
  | { status: 'error'; message: string }

export type ImportTagPreview = {
  artist: string | null
  title: string | null
  album: string | null
  year: string | null
  label: string | null
  catalogNumber: string | null
  trackPosition: string | null
  discogsReleaseId: number | null
  discogsTrackPosition: string | null
}

export type AudioAnalysis = {
  format: string
  codec: string | null
  channels: number | null
  sampleRateHz: number | null
  bitDepth: number | null
  bitrateKbps: number | null
  durationSeconds: number | null
  fileSizeBytes: number
  integratedLufs: number | null
  loudnessRangeLu: number | null
  truePeakDbfs: number | null
  peakLevelDb: number | null
  rmsLevelDb: number | null
  crestDb: number | null
  noiseFloorDb: number | null
  lowBandRmsDb: number | null
  highBandRmsDb: number | null
}

export type ImportReviewCandidate = {
  match: DiscogsTrackMatch
  proposedTags: ImportTagPreview
  destinationRelativePath: string
  exactExistingFilename: string | null
}

export type ImportReview = {
  filename: string
  parsed: { artist: string; title: string; version: string | null } | null
  selectedCandidateIndex: number | null
  candidates: ImportReviewCandidate[]
  similarItems: CollectionItem[]
  sourceAnalysis: AudioAnalysis | null
  tagWriteSupported: boolean
}

export type ImportComparison = {
  sourceFilename: string
  existingFilename: string
  sourceAnalysis: AudioAnalysis | null
  existingAnalysis: AudioAnalysis | null
}

export type ImportCommitInput = {
  filename: string
  match?: DiscogsTrackMatch | null
  tags?: ImportTagPreview | null
  mode?: 'import_new' | 'replace_existing'
  replaceFilename?: string | null
}

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
    get: () => Promise<AppSettings>
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
    getImportReview: (filename: string) => Promise<ImportReview>
    compareImport: (filename: string, existingFilename: string) => Promise<ImportComparison>
    commitImport: (input: ImportCommitInput) => Promise<ImportFileResult>
    importFile: (filename: string) => Promise<ImportFileResult>
    deleteFile: (filename: string) => Promise<void>
    clearEmptyFolders: () => Promise<number>
    showInFinder: (filename: string) => Promise<void>
    openInPlayer: (filename: string) => Promise<void>
  }
}

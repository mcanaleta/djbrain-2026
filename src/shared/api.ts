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
  isDownload?: boolean
  bitrateKbps?: number | null
  qualityScore?: number | null
  recordingId?: number | null
  recordingDiscogsUrl?: string | null
  recordingMusicBrainzUrl?: string | null
  identificationStatus?: IdentificationStatus | null
  identificationConfidence?: number | null
  assignmentMethod?: IdentificationAssignmentMethod | null
  recordingCanonical?: RecordingCanonical | null
  importStatus?: 'pending' | 'processing' | 'ready' | 'error' | null
  importArtist?: string | null
  importTitle?: string | null
  importVersion?: string | null
  importYear?: string | null
  importError?: string | null
  importTrackKey?: string | null
  importMatchArtist?: string | null
  importMatchTitle?: string | null
  importMatchVersion?: string | null
  importMatchYear?: string | null
  importReleaseTitle?: string | null
  importTrackPosition?: string | null
  importExactExistingFilename?: string | null
  importBetterThanExisting?: boolean | null
  importExistingQualityScore?: number | null
  importQualityScore?: number | null
}

export type CollectionSyncStatus = {
  isSyncing: boolean
  lastSyncedAt: string | null
  itemCount: number
  lastError: string | null
  automationEnabled?: boolean
  identificationPendingCount?: number
  identificationProcessingCount?: number
  identificationNeedsReviewCount?: number
  identificationErrorCount?: number
  importPendingCount?: number
  importProcessingCount?: number
  importErrorCount?: number
  queueBackend?: 'redis' | 'memory'
  queueDepth?: number
  audioHashVersion?: number
  audioAnalysisVersion?: number
  importReviewVersion?: number
}

export type CollectionListResult = {
  items: CollectionItem[]
  total: number
}

export type CollectionItemDetails = {
  filename: string
  filesize: number
  mtimeMs: number | null
  isDownload: boolean
  recordingId: number | null
  identificationStatus: IdentificationStatus | null
  identificationConfidence: number | null
  assignmentMethod: IdentificationAssignmentMethod | null
  recordingCanonical: RecordingCanonical | null
  tags: {
    source: string
    artist: string | null
    title: string | null
    version: string | null
    album: string | null
    year: string | null
    label: string | null
    catalogNumber: string | null
    trackPosition: string | null
    discogsReleaseId: number | null
    discogsTrackPosition: string | null
  } | null
  importReview: {
    filesize: number
    mtimeMs: number
    reviewVersion: number
    status: 'pending' | 'processing' | 'ready' | 'error'
    parsedArtist: string | null
    parsedTitle: string | null
    parsedVersion: string | null
    parsedYear: string | null
    reviewJson: string | null
    errorMessage: string | null
    processedAt: string | null
  } | null
  fileAudioState: {
    filesize: number
    mtimeMs: number
    hashVersion: number
    audioHash: string | null
    status: 'pending' | 'ready' | 'error'
    errorMessage: string | null
    processedAt: string | null
  } | null
  audioAnalysisCache: {
    audioHash: string
    analysisVersion: number
    analysisJson: string | null
    errorMessage: string | null
    processedAt: string | null
  } | null
  parsedAudioAnalysis: AudioAnalysis | null
  identification: FileIdentificationState | null
  upgradeCase: UpgradeCase | null
}

export type IdentificationStatus = 'pending' | 'processing' | 'ready' | 'needs_review' | 'error'

export type IdentificationAssignmentMethod = 'audio_hash' | 'source_claim' | 'heuristic' | 'manual'

export type RecordingCanonical = {
  artist: string | null
  title: string | null
  version: string | null
  year: string | null
}

export type IdentificationCandidate = {
  id: number
  filename: string
  provider: 'discogs' | 'musicbrainz' | 'tags' | 'filename' | 'manual'
  entityType: 'recording' | 'release_track' | 'release' | 'file_parse'
  externalKey: string
  proposedRecordingId: number | null
  score: number
  disposition: 'candidate' | 'accepted' | 'rejected'
  payloadJson: string | null
  recordingCanonical: RecordingCanonical | null
}

export type FileIdentificationState = {
  filename: string
  recordingId: number | null
  audioHash: string | null
  status: IdentificationStatus
  assignmentMethod: IdentificationAssignmentMethod | null
  confidence: number | null
  parsedArtist: string | null
  parsedTitle: string | null
  parsedVersion: string | null
  parsedYear: string | null
  tagArtist: string | null
  tagTitle: string | null
  tagVersion: string | null
  chosenClaimId: number | null
  identifyVersion: number
  explanationJson: string | null
  processedAt: string | null
  errorMessage: string | null
  recordingCanonical: RecordingCanonical | null
  candidates: IdentificationCandidate[]
}

export type RecordingSummary = {
  id: number
  canonical: RecordingCanonical
  confidence: number
  reviewState: 'auto' | 'confirmed' | 'merged'
  metadataLocked: boolean
  mergedIntoRecordingId: number | null
  fileCount: number
  claimCount: number
}

export type RecordingDetails = RecordingSummary & {
  sourceClaims: Array<{
    id: number
    provider: 'discogs' | 'musicbrainz' | 'tags' | 'filename' | 'manual'
    entityType: 'recording' | 'release_track' | 'release' | 'file_parse'
    externalKey: string
    artist: string | null
    title: string | null
    version: string | null
    releaseTitle: string | null
    trackPosition: string | null
    year: string | null
    durationSeconds: number | null
    confidence: number
    rawJson: string | null
  }>
  files: Array<{
    filename: string
    status: IdentificationStatus
    confidence: number | null
    assignmentMethod: IdentificationAssignmentMethod | null
  }>
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
  durationSeconds: number | null
  queueLength: number | null
  hasFreeUploadSlot: boolean | null
  uploadSpeed: number | null
  isLocked: boolean
  extension: string
}

export type UpgradeCaseStatus =
  | 'idle'
  | 'searching'
  | 'results_ready'
  | 'no_results'
  | 'downloading'
  | 'downloaded'
  | 'pending_reanalyze'
  | 'completed'
  | 'error'

export type UpgradeReferenceSource = 'discogs' | 'current_file'

export type UpgradeCandidateSpeedClass =
  | 'same_track_likely'
  | 'different_edit_likely'
  | 'unknown'

export type UpgradeCandidate = SlskdCandidate & {
  durationDeltaSeconds: number | null
  durationDeltaPercent: number | null
  speedClass: UpgradeCandidateSpeedClass
}

export type UpgradeLocalCandidate = {
  filename: string
  filesize: number
  durationSeconds: number | null
  source: 'auto_download' | 'import_folder'
  sourceUsername: string | null
  sourceFilename: string | null
}

export type UpgradeCase = {
  id: number
  collectionFilename: string
  status: UpgradeCaseStatus
  searchArtist: string
  searchTitle: string
  searchVersion: string | null
  currentDurationSeconds: number | null
  officialDurationSeconds: number | null
  officialDurationSource: UpgradeReferenceSource | null
  referenceDurationSeconds: number | null
  referenceDurationSource: UpgradeReferenceSource | null
  candidateCount: number
  localCandidateCount: number
  selectedCandidate: UpgradeCandidate | null
  selectedLocalFilename: string | null
  archiveFilename: string | null
  replacementFilename: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
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
  noiseScore: number | null
  lowBandRmsDb: number | null
  highBandRmsDb: number | null
  subBassRmsDb: number | null
  airBandRmsDb: number | null
  humRmsDb: number | null
  cutoffDb: number | null
  rumbleScore: number | null
  humScore: number | null
  vinylLikelihood: number | null
}

export type ImportReviewCandidate = {
  match: DiscogsTrackMatch
  proposedTags: ImportTagPreview
  destinationRelativePath: string
  exactExistingFilename: string | null
}

export type ImportReviewSearch = {
  artist: string
  title: string
  version: string | null
}

export type ImportReview = {
  filename: string
  parsed: { artist: string; title: string; version: string | null } | null
  search: ImportReviewSearch
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
    list: (query?: string, limit?: number) => Promise<CollectionListResult>
    get: (filename: string) => Promise<CollectionItemDetails | null>
    listDownloads: (query?: string) => Promise<CollectionListResult>
    reanalyze: (filename: string) => Promise<void>
    syncNow: () => Promise<CollectionSyncStatus>
    getStatus: () => Promise<CollectionSyncStatus>
    onUpdated: (listener: (status: CollectionSyncStatus) => void) => () => void
    getImportReview: (filename: string, search?: Partial<ImportReviewSearch>, force?: boolean) => Promise<ImportReview>
    compareImport: (filename: string, existingFilename: string) => Promise<ImportComparison>
    queueImportProcessing: (filenames?: string[], force?: boolean) => Promise<{ queued: number }>
    queueIdentificationProcessing: (filenames?: string[], force?: boolean) => Promise<{ queued: number }>
    reviewIdentification: (input: {
      filename: string
      action: 'accept' | 'reject' | 'create_recording'
      candidateId?: number | null
    }) => Promise<FileIdentificationState | null>
    listRecordings: (query?: string) => Promise<RecordingSummary[]>
    getRecording: (id: number) => Promise<RecordingDetails | null>
    assignRecording: (input: {
      recordingId?: number | null
      filenames: string[]
      create?: boolean
      canonical?: Partial<RecordingCanonical> | null
    }) => Promise<RecordingDetails | null>
    mergeRecordings: (sourceRecordingId: number, targetRecordingId: number) => Promise<RecordingDetails | null>
    commitImport: (input: ImportCommitInput) => Promise<ImportFileResult>
    importFile: (filename: string) => Promise<ImportFileResult>
    deleteFile: (filename: string) => Promise<void>
    clearEmptyFolders: () => Promise<number>
    showInFinder: (filename: string) => Promise<void>
    openInPlayer: (filename: string) => Promise<void>
  }
  upgrades: {
    list: () => Promise<UpgradeCase[]>
    open: (collectionFilename: string) => Promise<UpgradeCase>
    get: (id: number) => Promise<UpgradeCase | null>
    search: (id: number, search?: Partial<ImportReviewSearch>) => Promise<UpgradeCase | null>
    setReference: (
      id: number,
      input: { artist?: string; title?: string; version?: string | null; durationSeconds?: number | null }
    ) => Promise<UpgradeCase | null>
    getCandidates: (id: number) => Promise<UpgradeCandidate[]>
    getLocalCandidates: (id: number) => Promise<UpgradeLocalCandidate[]>
    download: (id: number, username: string, filename: string, size: number) => Promise<UpgradeCase | null>
    addLocalCandidate: (id: number, filename: string) => Promise<UpgradeCase | null>
    selectLocalCandidate: (id: number, filename: string) => Promise<UpgradeCase | null>
    replace: (id: number) => Promise<UpgradeCase | null>
    markReanalyzed: (id: number) => Promise<UpgradeCase | null>
  }
}

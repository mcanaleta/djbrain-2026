import type { Pool, PoolClient } from 'pg'
import { ensureAudioAnalysisCacheTable } from './schema/audio-analysis-cache.ts'
import { ensureAudioHashesTable } from './schema/audio-hashes.ts'
import { ensureAudioIdentificationCandidatesTable } from './schema/audio-identification-candidates.ts'
import { ensureCollectionFilesTable } from './schema/collection-files.ts'
import { ensureCollectionFileStateTable } from './schema/collection-file-state.ts'
import { ensureFileAudioStateTable } from './schema/file-audio-state.ts'
import { ensureFileIdentificationArchiveTable } from './schema/file-identification-archive.ts'
import { ensureFileIdentificationCandidatesTable } from './schema/file-identification-candidates.ts'
import { ensureFileIdentificationStateTable } from './schema/file-identification-state.ts'
import { ensureImportReviewCacheTable } from './schema/import-review-cache.ts'
import { ensureRecordingsTable } from './schema/recordings.ts'
import { ensureRecordingSourceClaimsTable } from './schema/recording-source-claims.ts'
import { ensureUpgradeCasesTable } from './schema/upgrade-cases.ts'
import { ensureWantListTable } from './schema/want-list.ts'

type Db = Pool | PoolClient

export async function ensureCollectionSchema(db: Db): Promise<void> {
  await ensureCollectionFilesTable(db)
  await ensureCollectionFileStateTable(db)
  await ensureImportReviewCacheTable(db)
  await ensureFileAudioStateTable(db)
  await ensureAudioAnalysisCacheTable(db)
  await ensureRecordingsTable(db)
  await ensureRecordingSourceClaimsTable(db)
  await ensureFileIdentificationStateTable(db)
  await ensureFileIdentificationCandidatesTable(db)
  await ensureFileIdentificationArchiveTable(db)
  await ensureAudioHashesTable(db)
  await ensureAudioIdentificationCandidatesTable(db)
  await ensureWantListTable(db)
  await ensureUpgradeCasesTable(db)
}

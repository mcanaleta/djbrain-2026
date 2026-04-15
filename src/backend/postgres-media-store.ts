import { Pool, type PoolClient } from 'pg'
import type { CollectionService } from './collection-service.ts'
import type { CollectionItem, CollectionItemDetails, CollectionListResult } from '../shared/api.ts'
import { parseImportFilename } from '../shared/import-filename.ts'

type MediaTags = NonNullable<CollectionItemDetails['tags']>

function toNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const normalized = Math.floor(Number(value))
  return normalized > 0 ? normalized : fallback
}

function normalizeJsonText(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

function toTimestampText(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : String(value)
}

function buildSearchDocumentSql(...values: string[]): string {
  return `regexp_replace(concat_ws(' ', ${values.join(', ')}), '[^[:alnum:]]+', ' ', 'g')`
}

function parseSelectedMatch(reviewJson: string | null | undefined): {
  album: string | null
  label: string | null
  catalogNumber: string | null
  trackPosition: string | null
  discogsReleaseId: number | null
  discogsTrackPosition: string | null
} {
  if (!reviewJson) {
    return {
      album: null,
      label: null,
      catalogNumber: null,
      trackPosition: null,
      discogsReleaseId: null,
      discogsTrackPosition: null
    }
  }

  try {
    const payload = JSON.parse(reviewJson) as {
      selectedCandidateIndex?: number | null
      candidates?: Array<{
        match?: {
          releaseTitle?: string | null
          label?: string | null
          catalogNumber?: string | null
          trackPosition?: string | null
          releaseId?: number | null
        } | null
      }>
    }
    const index = typeof payload.selectedCandidateIndex === 'number' ? payload.selectedCandidateIndex : 0
    const candidate = payload.candidates?.[index] ?? payload.candidates?.[0] ?? null
    const match = candidate?.match
    return {
      album: match?.releaseTitle ?? null,
      label: match?.label ?? null,
      catalogNumber: match?.catalogNumber ?? null,
      trackPosition: match?.trackPosition ?? null,
      discogsReleaseId: typeof match?.releaseId === 'number' ? match.releaseId : null,
      discogsTrackPosition: match?.trackPosition ?? null
    }
  } catch {
    return {
      album: null,
      label: null,
      catalogNumber: null,
      trackPosition: null,
      discogsReleaseId: null,
      discogsTrackPosition: null
    }
  }
}

function deriveTags(details: CollectionItemDetails): MediaTags | null {
  if (details.tags && (details.tags.artist || details.tags.title)) {
    return details.tags
  }

  const selected = parseSelectedMatch(details.importReview?.reviewJson)
  const parsed = parseImportFilename(details.filename)
  const artist = details.importReview?.parsedArtist ?? parsed?.artist ?? null
  const title = details.importReview?.parsedTitle ?? parsed?.title ?? null
  const version = details.importReview?.parsedVersion ?? parsed?.version ?? null
  const year = details.importReview?.parsedYear ?? parsed?.year ?? null

  if (!artist && !title) return null

  return {
    source: details.importReview ? 'import_review' : 'filename_parse',
    artist,
    title,
    version,
    album: selected.album,
    year,
    label: selected.label,
    catalogNumber: selected.catalogNumber,
    trackPosition: selected.trackPosition,
    discogsReleaseId: selected.discogsReleaseId,
    discogsTrackPosition: selected.discogsTrackPosition
  }
}

export class PostgresMediaStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8
    })
  }

  public async close(): Promise<void> {
    await this.pool.end()
  }

  public async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS media_files (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS media_tags (
        file_id BIGINT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        artist TEXT,
        title TEXT,
        version TEXT,
        album TEXT,
        year TEXT,
        label TEXT,
        catalog_number TEXT,
        track_position TEXT,
        discogs_release_id BIGINT,
        discogs_track_position TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS media_audio_state (
        file_id BIGINT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
        hash_version INTEGER,
        audio_hash TEXT,
        status TEXT,
        error_message TEXT,
        processed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS audio_analysis_cache (
        audio_hash TEXT NOT NULL,
        analysis_version INTEGER NOT NULL,
        analysis_json JSONB,
        error_message TEXT,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (audio_hash, analysis_version)
      );

      CREATE TABLE IF NOT EXISTS media_items (
        file_id BIGINT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        scope TEXT NOT NULL,
        filesize BIGINT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        artist TEXT,
        title TEXT,
        version TEXT,
        album TEXT,
        year TEXT,
        label TEXT,
        catalog_number TEXT,
        track_position TEXT,
        discogs_release_id BIGINT,
        discogs_track_position TEXT,
        analysis_status TEXT,
        audio_hash TEXT,
        analysis_version INTEGER,
        analysis_json JSONB,
        duration_seconds DOUBLE PRECISION,
        bitrate_kbps DOUBLE PRECISION,
        integrated_lufs DOUBLE PRECISION,
        import_review_version INTEGER,
        import_status TEXT,
        import_error_message TEXT,
        import_processed_at TIMESTAMPTZ,
        import_parsed_artist TEXT,
        import_parsed_title TEXT,
        import_parsed_version TEXT,
        import_parsed_year TEXT,
        import_review_json JSONB,
        search_vector TSVECTOR,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS media_items_search_vector_idx
      ON media_items USING GIN (search_vector);

      CREATE INDEX IF NOT EXISTS media_items_path_idx
      ON media_items(path);
    `)
  }

  public async rebuildFromCollection(service: CollectionService): Promise<number> {
    const snapshot = (await service.list('', Number.MAX_SAFE_INTEGER)).items
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('TRUNCATE media_items, media_tags, media_audio_state, media_files RESTART IDENTITY CASCADE')
      let imported = 0
      for (const item of snapshot) {
        const details = await service.getItem(item.filename)
        if (!details) continue
        await this.upsertDetailsWithClient(client, details)
        imported += 1
      }
      await client.query('COMMIT')
      return imported
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  public async upsertFromCollectionItem(service: CollectionService, filename: string): Promise<boolean> {
    const details = await service.getItem(filename)
    if (!details) return false
    await this.upsertDetailsWithClient(undefined, details)
    return true
  }

  public async deleteByFilename(filename: string): Promise<void> {
    await this.pool.query('DELETE FROM media_files WHERE path = $1', [filename])
  }

  public async list(query: string = '', limit?: number): Promise<CollectionListResult> {
    const normalizedLimit = normalizeLimit(limit, 100)
    const textQuery = query.trim()
    type ListRow = { filename: string; filesize: string | number; score: number | null }
    const rows: ListRow[] =
      textQuery.length > 0
        ? (
            await this.pool.query<{
              filename: string
              filesize: string | number
              score: number
            }>(
              `
                SELECT
                  path AS filename,
                  filesize,
                  ts_rank_cd(search_vector, plainto_tsquery('simple', $1)) AS score
                FROM media_items
                WHERE search_vector @@ plainto_tsquery('simple', $1)
                ORDER BY score DESC, path
                LIMIT $2::int
              `,
              [textQuery, normalizedLimit]
            )
          ).rows.map((row) => ({ ...row, score: toNumber(row.score, 0) }))
        : (
            await this.pool.query<{
              filename: string
              filesize: string | number
            }>(
              `
                SELECT path AS filename, filesize
                FROM media_items
                ORDER BY path
                LIMIT $1::int
              `,
              [normalizedLimit]
            )
          ).rows.map((row) => ({ ...row, score: null }))

    const items: CollectionItem[] = rows.map((row) => ({
      filename: row.filename,
      filesize: toNumber(row.filesize),
      duration: null,
      score: row.score
    }))
    return { items, total: items.length }
  }

  public async get(filename: string): Promise<CollectionItemDetails | null> {
    const result = await this.pool.query<{
      path: string
      filesize: string | number
      mtime_ms: string | number
      scope: string
      artist: string | null
      title: string | null
      version: string | null
      album: string | null
      year: string | null
      label: string | null
      catalog_number: string | null
      track_position: string | null
      discogs_release_id: string | number | null
      discogs_track_position: string | null
      analysis_status: string | null
      audio_hash: string | null
      analysis_version: number | null
      analysis_json: unknown | null
      audio_hash_version: number | null
      audio_error_message: string | null
      audio_processed_at: Date | string | null
      cache_error_message: string | null
      cache_processed_at: Date | string | null
      import_review_version: number | null
      import_status: 'pending' | 'processing' | 'ready' | 'error' | null
      import_error_message: string | null
      import_processed_at: Date | string | null
      import_parsed_artist: string | null
      import_parsed_title: string | null
      import_parsed_version: string | null
      import_parsed_year: string | null
      import_review_json: unknown | null
    }>(
      `
        SELECT
          mi.path, mi.filesize, mi.mtime_ms, mi.scope,
          mi.artist, mi.title, mi.version, mi.album, mi.year, mi.label, mi.catalog_number, mi.track_position, mi.discogs_release_id, mi.discogs_track_position,
          mi.analysis_status, mi.audio_hash, mi.analysis_version, mi.analysis_json,
          mas.hash_version AS audio_hash_version, mas.error_message AS audio_error_message, mas.processed_at AS audio_processed_at,
          aac.error_message AS cache_error_message, aac.processed_at AS cache_processed_at,
          mi.import_review_version, mi.import_status, mi.import_error_message, mi.import_processed_at,
          mi.import_parsed_artist, mi.import_parsed_title, mi.import_parsed_version, mi.import_parsed_year, mi.import_review_json
        FROM media_items mi
        LEFT JOIN media_audio_state mas ON mas.file_id = mi.file_id
        LEFT JOIN audio_analysis_cache aac
          ON aac.audio_hash = mi.audio_hash
         AND aac.analysis_version = mi.analysis_version
        WHERE mi.path = $1
      `,
      [filename]
    )
    const row = result.rows[0]
    if (!row) return null
    const analysisJsonText = row.analysis_json ? JSON.stringify(row.analysis_json) : null
    const importReviewJsonText = row.import_review_json ? JSON.stringify(row.import_review_json) : null
    return {
      filename: row.path,
      filesize: toNumber(row.filesize),
      mtimeMs: toNumber(row.mtime_ms, 0),
      isDownload: row.scope === 'downloads',
      recordingId: null,
      identificationStatus: null,
      identificationConfidence: null,
      assignmentMethod: null,
      recordingCanonical: null,
      tags: {
        source: 'media_tags',
        artist: row.artist,
        title: row.title,
        version: row.version,
        album: row.album,
        year: row.year,
        label: row.label,
        catalogNumber: row.catalog_number,
        trackPosition: row.track_position,
        discogsReleaseId: row.discogs_release_id == null ? null : toNumber(row.discogs_release_id),
        discogsTrackPosition: row.discogs_track_position
      },
      importReview:
        row.import_status
          ? {
              filesize: toNumber(row.filesize),
              mtimeMs: toNumber(row.mtime_ms),
              reviewVersion: toNumber(row.import_review_version ?? 0),
              status: row.import_status,
              parsedArtist: row.import_parsed_artist,
              parsedTitle: row.import_parsed_title,
              parsedVersion: row.import_parsed_version,
              parsedYear: row.import_parsed_year,
              reviewJson: importReviewJsonText,
              errorMessage: row.import_error_message,
              processedAt: toTimestampText(row.import_processed_at)
            }
          : null,
      fileAudioState:
        row.analysis_status || row.audio_hash
          ? {
              filesize: toNumber(row.filesize),
              mtimeMs: toNumber(row.mtime_ms),
              hashVersion: toNumber(row.audio_hash_version ?? 0),
              audioHash: row.audio_hash,
              status: (row.analysis_status as 'pending' | 'ready' | 'error') ?? 'pending',
              errorMessage: row.audio_error_message,
              processedAt: toTimestampText(row.audio_processed_at)
            }
          : null,
      audioAnalysisCache:
        row.audio_hash && row.analysis_version
          ? {
              audioHash: row.audio_hash,
              analysisVersion: row.analysis_version,
              analysisJson: analysisJsonText,
              errorMessage: row.cache_error_message,
              processedAt: toTimestampText(row.cache_processed_at)
            }
          : null,
      parsedAudioAnalysis: row.analysis_json as CollectionItemDetails['parsedAudioAnalysis'],
      identification: null,
      upgradeCase: null
    }
  }

  private async upsertDetailsWithClient(
    client: PoolClient | undefined,
    details: CollectionItemDetails
  ): Promise<void> {
    const runner = client ?? (await this.pool.connect())
    const ownClient = !client
    try {
      const scope = details.isDownload ? 'downloads' : 'songs'
      const fileResult = await runner.query<{ id: string | number }>(
        `
          INSERT INTO media_files(path, scope, filesize, mtime_ms, first_seen_at, last_seen_at, deleted_at)
          VALUES ($1, $2, $3, $4, now(), now(), NULL)
          ON CONFLICT(path) DO UPDATE SET
            scope = EXCLUDED.scope,
            filesize = EXCLUDED.filesize,
            mtime_ms = EXCLUDED.mtime_ms,
            last_seen_at = now(),
            deleted_at = NULL
          RETURNING id
        `,
        [details.filename, scope, details.filesize, details.mtimeMs ?? 0]
      )
      const fileId = toNumber(fileResult.rows[0]?.id)
      const tags = deriveTags(details)
      if (tags) {
        await runner.query(
          `
            INSERT INTO media_tags(
              file_id, source, artist, title, version, album, year, label, catalog_number, track_position,
              discogs_release_id, discogs_track_position, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
            ON CONFLICT(file_id) DO UPDATE SET
              source = EXCLUDED.source,
              artist = EXCLUDED.artist,
              title = EXCLUDED.title,
              version = EXCLUDED.version,
              album = EXCLUDED.album,
              year = EXCLUDED.year,
              label = EXCLUDED.label,
              catalog_number = EXCLUDED.catalog_number,
              track_position = EXCLUDED.track_position,
              discogs_release_id = EXCLUDED.discogs_release_id,
              discogs_track_position = EXCLUDED.discogs_track_position,
              updated_at = now()
          `,
          [
            fileId,
            tags.source,
            tags.artist,
            tags.title,
            tags.version,
            tags.album,
            tags.year,
            tags.label,
            tags.catalogNumber,
            tags.trackPosition,
            tags.discogsReleaseId,
            tags.discogsTrackPosition
          ]
        )
      } else {
        await runner.query('DELETE FROM media_tags WHERE file_id = $1', [fileId])
      }

      if (details.fileAudioState) {
        await runner.query(
          `
            INSERT INTO media_audio_state(file_id, hash_version, audio_hash, status, error_message, processed_at)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT(file_id) DO UPDATE SET
              hash_version = EXCLUDED.hash_version,
              audio_hash = EXCLUDED.audio_hash,
              status = EXCLUDED.status,
              error_message = EXCLUDED.error_message,
              processed_at = EXCLUDED.processed_at
          `,
          [
            fileId,
            details.fileAudioState.hashVersion,
            details.fileAudioState.audioHash,
            details.fileAudioState.status,
            details.fileAudioState.errorMessage,
            details.fileAudioState.processedAt
          ]
        )
      } else {
        await runner.query('DELETE FROM media_audio_state WHERE file_id = $1', [fileId])
      }

      if (details.audioAnalysisCache?.audioHash) {
        await runner.query(
          `
            INSERT INTO audio_analysis_cache(audio_hash, analysis_version, analysis_json, error_message, processed_at)
            VALUES ($1, $2, $3::jsonb, $4, $5)
            ON CONFLICT(audio_hash, analysis_version) DO UPDATE SET
              analysis_json = EXCLUDED.analysis_json,
              error_message = EXCLUDED.error_message,
              processed_at = EXCLUDED.processed_at
          `,
          [
            details.audioAnalysisCache.audioHash,
            details.audioAnalysisCache.analysisVersion,
            details.audioAnalysisCache.analysisJson ?? null,
            details.audioAnalysisCache.errorMessage,
            details.audioAnalysisCache.processedAt
          ]
        )
      }

      const analysisJson = details.parsedAudioAnalysis ? JSON.stringify(details.parsedAudioAnalysis) : null
      const importReviewJson = normalizeJsonText(details.importReview?.reviewJson)
      const searchDocumentSql = buildSearchDocumentSql(
        '$2::text',
        '$6::text',
        '$7::text',
        '$8::text',
        '$9::text',
        '$10::text',
        '$11::text'
      )
      await runner.query(
        `
          INSERT INTO media_items(
            file_id, path, scope, filesize, mtime_ms,
            artist, title, version, album, year, label, catalog_number, track_position, discogs_release_id, discogs_track_position,
            analysis_status, audio_hash, analysis_version, analysis_json, duration_seconds, bitrate_kbps, integrated_lufs,
            import_review_version, import_status, import_error_message, import_processed_at,
            import_parsed_artist, import_parsed_title, import_parsed_version, import_parsed_year, import_review_json,
            search_vector, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19::jsonb, $20, $21, $22,
            $23, $24, $25, $26,
            $27, $28, $29, $30, $31::jsonb,
            to_tsvector('simple', ${searchDocumentSql}), now()
          )
          ON CONFLICT(file_id) DO UPDATE SET
            path = EXCLUDED.path,
            scope = EXCLUDED.scope,
            filesize = EXCLUDED.filesize,
            mtime_ms = EXCLUDED.mtime_ms,
            artist = EXCLUDED.artist,
            title = EXCLUDED.title,
            version = EXCLUDED.version,
            album = EXCLUDED.album,
            year = EXCLUDED.year,
            label = EXCLUDED.label,
            catalog_number = EXCLUDED.catalog_number,
            track_position = EXCLUDED.track_position,
            discogs_release_id = EXCLUDED.discogs_release_id,
            discogs_track_position = EXCLUDED.discogs_track_position,
            analysis_status = EXCLUDED.analysis_status,
            audio_hash = EXCLUDED.audio_hash,
            analysis_version = EXCLUDED.analysis_version,
            analysis_json = EXCLUDED.analysis_json,
            duration_seconds = EXCLUDED.duration_seconds,
            bitrate_kbps = EXCLUDED.bitrate_kbps,
            integrated_lufs = EXCLUDED.integrated_lufs,
            import_review_version = EXCLUDED.import_review_version,
            import_status = EXCLUDED.import_status,
            import_error_message = EXCLUDED.import_error_message,
            import_processed_at = EXCLUDED.import_processed_at,
            import_parsed_artist = EXCLUDED.import_parsed_artist,
            import_parsed_title = EXCLUDED.import_parsed_title,
            import_parsed_version = EXCLUDED.import_parsed_version,
            import_parsed_year = EXCLUDED.import_parsed_year,
            import_review_json = EXCLUDED.import_review_json,
            search_vector = EXCLUDED.search_vector,
            updated_at = now()
        `,
        [
          fileId,
          details.filename,
          scope,
          details.filesize,
          details.mtimeMs ?? 0,
          tags?.artist ?? null,
          tags?.title ?? null,
          tags?.version ?? null,
          tags?.album ?? null,
          tags?.year ?? null,
          tags?.label ?? null,
          tags?.catalogNumber ?? null,
          tags?.trackPosition ?? null,
          tags?.discogsReleaseId ?? null,
          tags?.discogsTrackPosition ?? null,
          details.fileAudioState?.status ?? null,
          details.fileAudioState?.audioHash ?? null,
          details.audioAnalysisCache?.analysisVersion ?? null,
          analysisJson,
          details.parsedAudioAnalysis?.durationSeconds ?? null,
          details.parsedAudioAnalysis?.bitrateKbps ?? null,
          details.parsedAudioAnalysis?.integratedLufs ?? null,
          details.importReview?.reviewVersion ?? null,
          details.importReview?.status ?? null,
          details.importReview?.errorMessage ?? null,
          details.importReview?.processedAt ?? null,
          details.importReview?.parsedArtist ?? null,
          details.importReview?.parsedTitle ?? null,
          details.importReview?.parsedVersion ?? null,
          details.importReview?.parsedYear ?? null,
          importReviewJson
        ]
      )
    } finally {
      if (ownClient) {
        runner.release()
      }
    }
  }
}

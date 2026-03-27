import { access } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CollectionService } from './collection-service.ts'
import type { DiscogsMatchService } from './discogs-match-service.ts'
import type { AudioAnalysisService } from './audio-analysis-service.ts'
import type { TaggerService } from './tagger-service.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { AppSettings } from './settings-store.ts'
import { buildImportDestRelativePath } from './import-service.ts'
import type { DiscogsTrackMatch } from '../shared/discogs-match.ts'
import type { AudioAnalysis, ImportReview, ImportReviewSearch, ImportTagPreview } from '../shared/api.ts'

type ParsedImport = NonNullable<ImportReview['parsed']>

type BuildImportReviewInput = {
  filename: string
  absolutePath: string
  parsed: ParsedImport
  searchValue?: unknown
  settings: AppSettings
  sourceAnalysis?: AudioAnalysis | null
}

type ImportReviewServiceDeps = {
  getCollectionService: () => CollectionService
  resolveMusicRelativePath: (filename: string) => string
  getAudioDuration: (filePath: string) => Promise<number | null>
  isDownloadFilename: (filename: string) => boolean
  discogsMatchService: DiscogsMatchService
  audioAnalysisService: AudioAnalysisService
  taggerService: TaggerService
  onlineSearchService: OnlineSearchService
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function normalizeSearchText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function strongSearchTerms(value: string | null | undefined): string[] {
  return normalizeSearchText(value).toLowerCase().split(' ').filter((term) => term.length > 1 && !/^\d+$/.test(term))
}

function buildImportTagPreview(match: DiscogsTrackMatch): ImportTagPreview {
  return {
    artist: match.artist,
    title: match.title,
    album: match.releaseTitle,
    year: match.year,
    label: match.label,
    catalogNumber: match.catalogNumber,
    trackPosition: match.trackPosition,
    discogsReleaseId: match.releaseId,
    discogsTrackPosition: match.trackPosition
  }
}

function dedupeMatches(matches: DiscogsTrackMatch[]): DiscogsTrackMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    const key = [match.releaseId, match.trackPosition, match.artist, match.title, match.version].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isLikelySimilarTrack(filename: string, parsed: ImportReviewSearch): boolean {
  const normalized = normalizeSearchText(filename).toLowerCase()
  const artistTerms = strongSearchTerms(parsed.artist)
  const titleTerms = strongSearchTerms(parsed.title)
  const versionTerms = strongSearchTerms(parsed.version)
  const artistHit = artistTerms.length === 0 || artistTerms.some((term) => normalized.includes(term))
  const titleHit = titleTerms.length === 0 || titleTerms.some((term) => normalized.includes(term))
  const versionHit = versionTerms.length === 0 || versionTerms.some((term) => normalized.includes(term))
  return artistHit && titleHit && versionHit
}

function resolveImportReviewSearch(parsed: ParsedImport, value: unknown): ImportReviewSearch {
  if (typeof value !== 'object' || value === null) return parsed
  const search = value as Partial<ImportReviewSearch>
  const text = (input: unknown, fallback: string): string => (typeof input === 'string' ? normalizeSearchText(input) : fallback)
  return {
    artist: text(search.artist, parsed.artist),
    title: text(search.title, parsed.title),
    version:
      typeof search.version === 'string'
        ? normalizeSearchText(search.version) || null
        : search.version === null
          ? null
          : parsed.version
  }
}

export class ImportReviewService {
  private readonly deps: ImportReviewServiceDeps

  constructor(deps: ImportReviewServiceDeps) {
    this.deps = deps
  }

  async build({ filename, absolutePath, parsed, searchValue, settings, sourceAnalysis }: BuildImportReviewInput): Promise<ImportReview> {
    const search = resolveImportReviewSearch(parsed, searchValue)
    const { match, candidates } = await this.deps.discogsMatchService.findTrack(
      settings,
      search.artist,
      search.title,
      search.version,
      this.deps.onlineSearchService
    )
    const ext = extname(absolutePath).toLowerCase()
    const reviewCandidates = await Promise.all(
      dedupeMatches(match ? [match, ...candidates] : candidates)
        .slice(0, 8)
        .map(async (candidate) => {
          const destinationRelativePath = buildImportDestRelativePath(settings.songsFolderPath, candidate, ext)
          return {
            match: candidate,
            proposedTags: buildImportTagPreview(candidate),
            destinationRelativePath,
            exactExistingFilename: (await fileExists(join(settings.musicFolderPath, destinationRelativePath))) ? destinationRelativePath : null
          }
        })
    )
    const similarItems = this.deps.getCollectionService()
      .list([search.artist, search.title, search.version].filter(Boolean).join(' '))
      .items
      .filter((item) => item.filename !== filename && !this.deps.isDownloadFilename(item.filename) && isLikelySimilarTrack(item.filename, search))
      .slice(0, 12)
    const [similarItemsWithDuration, resolvedSourceAnalysis] = await Promise.all([
      Promise.all(
        similarItems.map(async (item) => ({
          ...item,
          duration: await this.deps.getAudioDuration(this.deps.resolveMusicRelativePath(item.filename))
        }))
      ),
      sourceAnalysis !== undefined
        ? Promise.resolve(sourceAnalysis)
        : this.deps.audioAnalysisService.analyze(absolutePath).catch(() => null)
    ])

    return {
      filename,
      parsed,
      search,
      selectedCandidateIndex: reviewCandidates.length > 0 ? 0 : null,
      candidates: reviewCandidates,
      similarItems: similarItemsWithDuration,
      sourceAnalysis: resolvedSourceAnalysis ?? null,
      tagWriteSupported: this.deps.taggerService.supportsFile(absolutePath)
    }
  }
}

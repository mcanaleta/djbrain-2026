import type { CollectionService } from './collection-service.ts'
import type { DiscogsMatchService } from './discogs-match-service.ts'
import type { FileAnalysisService } from './file-analysis-service.ts'
import { normalizeSearchText } from './collection-service-helpers.ts'
import type { MusicBrainzService } from './musicbrainz-service.ts'
import type { OnlineSearchService } from './online-search-service.ts'
import type { AppSettings } from './settings-store.ts'
import type { AudioTags, TaggerService } from './tagger-service.ts'
import type {
  IdentificationAssignmentMethod,
  IdentificationStatus,
  ImportReview,
  RecordingCanonical
} from '../shared/api.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
import { parseTrackTitle } from '../shared/track-title-parser.ts'

type RecordingClaimProvider = 'discogs' | 'musicbrainz' | 'tags' | 'filename' | 'manual'
type RecordingClaimEntityType = 'recording' | 'release_track' | 'release' | 'file_parse'

export type RecordingClaimInput = {
  provider: RecordingClaimProvider
  entityType: RecordingClaimEntityType
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
}

export type RecordingMatchRow = {
  id: number
  canonical: RecordingCanonical
  confidence: number
  reviewState: 'auto' | 'confirmed' | 'merged'
  metadataLocked: boolean
  mergedIntoRecordingId: number | null
  claims: RecordingClaimInput[]
}

export type SourceClaimMatch = {
  claimId: number
  recordingId: number
  externalKey: string
  confidence: number
  canonical: RecordingCanonical
}

export type RecordingCandidateSuggestion = {
  provider: RecordingClaimProvider
  entityType: RecordingClaimEntityType
  externalKey: string
  proposedRecordingId: number | null
  score: number
  disposition: 'candidate' | 'accepted' | 'rejected'
  payloadJson: string | null
  recordingCanonical: RecordingCanonical | null
}

export type IdentificationDecision = {
  status: IdentificationStatus
  assignmentMethod: IdentificationAssignmentMethod | null
  confidence: number | null
  recordingId: number | null
  createRecording: {
    canonical: RecordingCanonical
    confidence: number
    reviewState: 'auto' | 'confirmed'
  } | null
  audioHash: string | null
  parsedArtist: string | null
  parsedTitle: string | null
  parsedVersion: string | null
  parsedYear: string | null
  tagArtist: string | null
  tagTitle: string | null
  tagVersion: string | null
  chosenClaimId: number | null
  chosenExternalKey: string | null
  acceptedClaims: RecordingClaimInput[]
  candidates: RecordingCandidateSuggestion[]
  explanationJson: string
  recordingCanonical: RecordingCanonical | null
}

type RecordingIdentityServiceDeps = {
  collectionService: CollectionService
  fileAnalysisService: FileAnalysisService
  taggerService: TaggerService
  discogsMatchService: DiscogsMatchService
  musicbrainzService: MusicBrainzService
  onlineSearchService: OnlineSearchService
  resolveMusicRelativePath: (filename: string) => string
  getSettings: () => AppSettings
}

type IdentityEvidence = {
  artist: string | null
  title: string | null
  version: string | null
  year: string | null
  durationSeconds: number | null
  releaseTitle: string | null
  provider: RecordingClaimProvider
}

type ResolveClaimsInput = {
  claims: RecordingClaimInput[]
  parsed: RecordingCanonical
  tagCanonical: RecordingCanonical | null
  audioHash: string | null
  durationSeconds: number | null
  rejectedKeys: Set<string>
  includeNeedsReview: boolean
}

export function normalizeIdentityText(value: string | null | undefined): string {
  return normalizeSearchText(value ?? '')
}

export function buildCanonicalNormKey(canonical: RecordingCanonical): string {
  return [canonical.artist, canonical.title, canonical.version].map(normalizeIdentityText).filter(Boolean).join(':')
}

function buildClaimKey(provider: string, value: string): string {
  return `${provider}:${value}`
}

function buildFilenameExternalKey(canonical: RecordingCanonical): string {
  return buildClaimKey('filename', buildCanonicalNormKey(canonical))
}

function buildTagExternalKey(tags: Pick<AudioTags, 'artist' | 'title' | 'trackPosition'> & { version: string | null }): string {
  return buildClaimKey(
    'tags',
    [tags.artist, tags.title, tags.version, tags.trackPosition].map(normalizeIdentityText).filter(Boolean).join(':')
  )
}

function buildDiscogsExternalKey(releaseId: number, trackPosition: string | null, title: string | null): string {
  return buildClaimKey(
    'discogs',
    [`release:${releaseId}`, `track:${normalizeIdentityText(trackPosition) || normalizeIdentityText(title) || 'unknown'}`].join(':')
  )
}

function buildMusicBrainzExternalKey(recordingId: string): string {
  return buildClaimKey('musicbrainz', `recording:${recordingId.trim().toLowerCase()}`)
}

function cleanupText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return normalized || null
}

function cleanupArtistText(value: string | null | undefined): string | null {
  const normalized = cleanupText(value)
  if (!normalized) return null
  const withoutSuffix = normalized.replace(/\s+\(\d+\)$/g, '') || normalized
  const articleMatch = withoutSuffix.match(/^(.+),\s*(the|a|an)$/i)
  return articleMatch ? `${articleMatch[2][0].toUpperCase()}${articleMatch[2].slice(1).toLowerCase()} ${articleMatch[1].trim()}` : withoutSuffix
}

function normalizeClaimFields(value: {
  artist?: string | null
  title?: string | null
  version?: string | null
}): {
  artist: string | null
  title: string | null
  version: string | null
} {
  const parsedTitle = parseTrackTitle(value.title?.trim() || '')
  return {
    artist: cleanupArtistText(value.artist),
    title: cleanupText(parsedTitle.title || value.title),
    version: cleanupText(value.version ?? parsedTitle.version)
  }
}

function toCanonical(value: Partial<RecordingCanonical> | null | undefined): RecordingCanonical {
  return {
    artist: cleanupArtistText(value?.artist),
    title: cleanupText(value?.title),
    version: cleanupText(value?.version),
    year: cleanupText(value?.year)
  }
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(normalizeIdentityText(left) && normalizeIdentityText(left) === normalizeIdentityText(right))
}

function stripLeadingArtist(title: string | null | undefined, artist: string | null | undefined): string | null {
  const cleanTitle = cleanupText(title)
  const cleanArtist = cleanupArtistText(artist)
  if (!cleanTitle || !cleanArtist) return cleanTitle
  return normalizeIdentityText(cleanTitle).startsWith(`${normalizeIdentityText(cleanArtist)} `)
    ? cleanupText(cleanTitle.slice(cleanArtist.length).replace(/^\s*[-–—:]+\s*/, ''))
    : cleanTitle
}

function isGenericArtist(value: string | null | undefined): boolean {
  return ['va', 'various', 'various artists'].includes(normalizeIdentityText(value))
}

function rankClaim(claim: RecordingClaimInput): number {
  return claim.confidence + (!isGenericArtist(claim.artist) ? 5 : 0) + (claim.provider === 'discogs' ? 2 : claim.provider === 'musicbrainz' ? 1 : 0)
}

function sortClaims(claims: RecordingClaimInput[]): RecordingClaimInput[] {
  return [...claims].sort((left, right) => rankClaim(right) - rankClaim(left))
}

function bestClaim(claims: RecordingClaimInput[], provider: RecordingClaimProvider): RecordingClaimInput | null {
  return sortClaims(claims.filter((claim) => claim.provider === provider))[0] ?? null
}

function bestExternalKey(claims: RecordingClaimInput[]): string | null {
  return (
    sortClaims(claims.filter((claim) => claim.provider === 'discogs' || claim.provider === 'musicbrainz'))[0]?.externalKey ??
    sortClaims(claims)[0]?.externalKey ??
    null
  )
}

function pickCanonical(
  discogsClaim: RecordingClaimInput | null,
  musicbrainzClaim: RecordingClaimInput | null,
  tagClaim: RecordingClaimInput | null,
  filenameClaim: RecordingClaimInput | null
): RecordingCanonical | null {
  const artist = tagClaim?.artist ?? filenameClaim?.artist ?? null
  const title = tagClaim?.title ?? filenameClaim?.title ?? null
  const chosen =
    [discogsClaim, musicbrainzClaim, tagClaim, filenameClaim].find(
      (claim) =>
        claim &&
        !isGenericArtist(claim.artist) &&
        (!artist || sameText(claim.artist, artist)) &&
        (!title || sameText(claim.title, title))
    ) ??
    tagClaim ??
    filenameClaim ??
    [discogsClaim, musicbrainzClaim].find((claim) => claim && !isGenericArtist(claim.artist)) ??
    discogsClaim ??
    musicbrainzClaim
  if (!chosen) return null
  return {
    artist: chosen.artist ?? artist,
    title: chosen.title ?? title,
    version: chosen.version ?? tagClaim?.version ?? filenameClaim?.version ?? null,
    year: chosen.year ?? discogsClaim?.year ?? musicbrainzClaim?.year ?? tagClaim?.year ?? filenameClaim?.year ?? null
  }
}

function pickSourceMatchCanonical(
  matchedClaim: RecordingClaimInput | null,
  matchedCanonical: RecordingCanonical | null,
  tagCanonical: RecordingCanonical | null,
  parsed: RecordingCanonical
): RecordingCanonical | null {
  return toCanonical({
    artist: matchedClaim?.artist ?? tagCanonical?.artist ?? parsed.artist ?? matchedCanonical?.artist,
    title: matchedClaim?.title ?? tagCanonical?.title ?? parsed.title ?? matchedCanonical?.title,
    version: matchedClaim?.version ?? tagCanonical?.version ?? parsed.version ?? matchedCanonical?.version,
    year: matchedClaim?.year ?? tagCanonical?.year ?? parsed.year ?? matchedCanonical?.year
  })
}

function parseImportReviewClaim(reviewJson: string | null | undefined): RecordingClaimInput | null {
  if (!reviewJson) return null
  try {
    const review = JSON.parse(reviewJson) as ImportReview
    const candidate = review.candidates[review.selectedCandidateIndex ?? 0] ?? review.candidates[0] ?? null
    const match = candidate?.match
    if (!match?.releaseId) return null
    const normalized = normalizeClaimFields({
      artist: match.artist,
      title: match.title,
      version: match.version
    })
    return {
      provider: 'discogs',
      entityType: 'release_track',
      externalKey: buildDiscogsExternalKey(match.releaseId, match.trackPosition ?? null, match.title),
      artist: normalized.artist,
      title: normalized.title,
      version: normalized.version,
      releaseTitle: cleanupText(match.releaseTitle),
      trackPosition: cleanupText(match.trackPosition),
      year: cleanupText(match.year),
      durationSeconds: match.durationSeconds ?? null,
      confidence: Math.min(100, Math.max(70, Math.round(match.score))),
      rawJson: JSON.stringify(match)
    }
  } catch {
    return null
  }
}

function dedupeClaims(claims: RecordingClaimInput[]): RecordingClaimInput[] {
  const map = new Map<string, RecordingClaimInput>()
  for (const claim of claims) {
    const existing = map.get(claim.externalKey)
    if (!existing || existing.confidence < claim.confidence) map.set(claim.externalKey, claim)
  }
  return [...map.values()]
}

function scoreMetadataMatch(evidence: IdentityEvidence, candidate: IdentityEvidence): number {
  let score = 0
  if (sameText(evidence.artist, candidate.artist)) score += 20
  if (sameText(evidence.title, candidate.title)) score += 25
  if (sameText(evidence.version, candidate.version)) score += 15
  else if (!cleanupText(evidence.version) && !cleanupText(candidate.version)) score += 5
  else if (cleanupText(evidence.version) && cleanupText(candidate.version)) score -= 20
  if (evidence.durationSeconds != null && candidate.durationSeconds != null) {
    const delta = Math.abs(evidence.durationSeconds - candidate.durationSeconds)
    if (delta <= 2) score += 20
    else if (delta <= 5) score += 10
    else if (delta <= 10) score += 5
    else if (delta > 20) score -= 25
  }
  if (sameText(evidence.year, candidate.year)) score += 5
  if (sameText(evidence.releaseTitle, candidate.releaseTitle)) score += 10
  return score
}

export function scoreRecordingCandidate(
  filenameEvidence: IdentityEvidence | null,
  tagEvidence: IdentityEvidence | null,
  candidate: RecordingMatchRow
): number {
  const sources: IdentityEvidence[] = []
  if (filenameEvidence) sources.push(filenameEvidence)
  if (tagEvidence) sources.push(tagEvidence)
  if (sources.length === 0) return 0

  let best = 0
  const candidateOptions = [
    {
      artist: candidate.canonical.artist,
      title: candidate.canonical.title,
      version: candidate.canonical.version,
      year: candidate.canonical.year,
      durationSeconds: null,
      releaseTitle: null,
      provider: 'manual'
    } satisfies IdentityEvidence,
    ...candidate.claims.map(
      (claim) =>
        ({
          artist: claim.artist,
          title: claim.title,
          version: claim.version,
          year: claim.year,
          durationSeconds: claim.durationSeconds,
          releaseTitle: claim.releaseTitle,
          provider: claim.provider
        }) satisfies IdentityEvidence
    )
  ]

  for (const source of sources) {
    for (const option of candidateOptions) {
      best = Math.max(best, scoreMetadataMatch(source, option))
    }
  }

  const canonical = {
    artist: candidate.canonical.artist,
    title: candidate.canonical.title,
    version: candidate.canonical.version,
    year: candidate.canonical.year,
    durationSeconds: null,
    releaseTitle: null,
    provider: 'manual'
  } satisfies IdentityEvidence
  if (filenameEvidence && sameText(filenameEvidence.artist, canonical.artist) && sameText(filenameEvidence.title, canonical.title)) {
    best += 10
  }
  if (tagEvidence && sameText(tagEvidence.artist, canonical.artist) && sameText(tagEvidence.title, canonical.title)) {
    best += 10
  }

  return Math.max(0, best)
}

function buildEvidenceScore(claims: RecordingClaimInput[], durationSeconds: number | null): number {
  let score = 0
  const best = (provider: RecordingClaimProvider) => claims.find((claim) => claim.provider === provider) ?? null
  const filenameClaim = best('filename')
  const tagClaim = best('tags')
  const discogsClaim = best('discogs')
  const musicbrainzClaim = best('musicbrainz')
  const primary = discogsClaim ?? musicbrainzClaim ?? tagClaim ?? filenameClaim
  if (primary?.artist && primary.title) score += 50
  if (primary?.version) score += 10
  if (filenameClaim && tagClaim && sameText(filenameClaim.artist, tagClaim.artist) && sameText(filenameClaim.title, tagClaim.title)) score += 10
  if (discogsClaim || musicbrainzClaim) score += 20
  if (durationSeconds != null) score += 10
  return Math.min(100, score)
}

function buildExplanation(value: unknown): string {
  return JSON.stringify(value)
}

export class RecordingIdentityService {
  private readonly deps: RecordingIdentityServiceDeps

  constructor(deps: RecordingIdentityServiceDeps) {
    this.deps = deps
  }

  private async resolveClaims({
    claims,
    parsed,
    tagCanonical,
    audioHash,
    durationSeconds,
    rejectedKeys,
    includeNeedsReview
  }: ResolveClaimsInput): Promise<IdentificationDecision | null> {
    const dedupedClaims = dedupeClaims(claims)
    const rankedClaims = sortClaims(dedupedClaims)
    const filenameEvidence = dedupedClaims.find((claim) => claim.provider === 'filename') ?? null
    const tagEvidence = dedupedClaims.find((claim) => claim.provider === 'tags') ?? null
    const baseDecision = {
      audioHash: audioHash ?? null,
      parsedArtist: parsed.artist,
      parsedTitle: parsed.title,
      parsedVersion: parsed.version,
      parsedYear: parsed.year,
      tagArtist: tagCanonical?.artist ?? null,
      tagTitle: tagCanonical?.title ?? null,
      tagVersion: tagCanonical?.version ?? null
    }

    if (audioHash) {
      const audioMatch = await this.deps.collectionService.findRecordingByAudioHash(audioHash)
      if (audioMatch) {
        const acceptedClaims = sortClaims(dedupedClaims.filter((claim) => claim.confidence >= 80))
        const audioCanonical =
          pickCanonical(
            bestClaim(rankedClaims, 'discogs'),
            bestClaim(rankedClaims, 'musicbrainz'),
            tagEvidence,
            filenameEvidence
          ) ?? pickSourceMatchCanonical(acceptedClaims[0] ?? null, audioMatch.canonical, tagCanonical, parsed)
        return {
          status: 'ready',
          assignmentMethod: 'audio_hash',
          confidence: 100,
          recordingId: audioMatch.recordingId,
          createRecording: null,
          chosenClaimId: null,
          chosenExternalKey: bestExternalKey(acceptedClaims),
          acceptedClaims,
          candidates: acceptedClaims.map((claim) => ({
            provider: claim.provider,
            entityType: claim.entityType,
            externalKey: claim.externalKey,
            proposedRecordingId: audioMatch.recordingId,
            score: 100,
            disposition: 'accepted',
            payloadJson: JSON.stringify(claim),
            recordingCanonical: audioCanonical ?? audioMatch.canonical
          })),
          explanationJson: buildExplanation({ reason: 'audio_hash_match', audioHash }),
          recordingCanonical: audioCanonical ?? audioMatch.canonical,
          ...baseDecision
        }
      }
    }

    const sourceMatches = dedupedClaims.length
      ? await this.deps.collectionService.findSourceClaimMatches(dedupedClaims.map((claim) => claim.externalKey))
      : []
    if (sourceMatches.length > 0) {
      const grouped = new Map<number, { score: number; match: SourceClaimMatch }>()
      for (const match of sourceMatches) {
        const current = grouped.get(match.recordingId)
        const nextScore = (current?.score ?? 0) + match.confidence + 100
        if (!current || current.score < nextScore) grouped.set(match.recordingId, { score: nextScore, match })
      }
      const ranked = [...grouped.values()].sort((left, right) => right.score - left.score)
      const leader = ranked[0]
      const runnerUp = ranked[1]
      if (leader && (!runnerUp || leader.score - runnerUp.score >= 8)) {
        const matchedClaim = dedupedClaims.find((claim) => claim.externalKey === leader.match.externalKey) ?? null
        const acceptedClaims = sortClaims(dedupedClaims.filter((claim) => claim.confidence >= 75))
        const sourceCanonical = pickSourceMatchCanonical(matchedClaim, leader.match.canonical, tagCanonical, parsed)
        return {
          status: 'ready',
          assignmentMethod: 'source_claim',
          confidence: 95,
          recordingId: leader.match.recordingId,
          createRecording: null,
          chosenClaimId: leader.match.claimId,
          chosenExternalKey: leader.match.externalKey,
          acceptedClaims,
          candidates: dedupedClaims.map((claim) => ({
            provider: claim.provider,
            entityType: claim.entityType,
            externalKey: claim.externalKey,
            proposedRecordingId: sourceMatches.find((row) => row.externalKey === claim.externalKey)?.recordingId ?? null,
            score: claim.externalKey === leader.match.externalKey ? 95 : claim.confidence,
            disposition: claim.externalKey === leader.match.externalKey ? 'accepted' : rejectedKeys.has(claim.externalKey) ? 'rejected' : 'candidate',
            payloadJson: JSON.stringify(claim),
            recordingCanonical: sourceMatches.find((row) => row.externalKey === claim.externalKey)?.canonical ?? null
          })),
          explanationJson: buildExplanation({ reason: 'source_claim_match', chosenExternalKey: leader.match.externalKey }),
          recordingCanonical: sourceCanonical ?? leader.match.canonical,
          ...baseDecision
        }
      }
    }

    const recordings = await this.deps.collectionService.listRecordingsForMatching()
    const toEvidence = (claim: RecordingClaimInput | null): IdentityEvidence | null =>
      claim
        ? {
            artist: claim.artist,
            title: claim.title,
            version: claim.version,
            year: claim.year,
            durationSeconds: claim.durationSeconds,
            releaseTitle: claim.releaseTitle,
            provider: claim.provider
          }
        : null
    const rankedRecordings = recordings
      .map((recording) => ({
        recording,
        score: scoreRecordingCandidate(toEvidence(filenameEvidence), toEvidence(tagEvidence), recording)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)

    const best = rankedRecordings[0] ?? null
    const next = rankedRecordings[1] ?? null
    const canonical = pickCanonical(
      bestClaim(rankedClaims, 'discogs'),
      bestClaim(rankedClaims, 'musicbrainz'),
      tagEvidence ?? null,
      filenameEvidence ?? null
    )
    const evidenceScore = buildEvidenceScore(dedupedClaims, durationSeconds)
    const heuristicCandidates = dedupedClaims
      .map((claim) => {
        const proposedRecording = rankedRecordings.find(
          (candidate) =>
            candidate.recording.claims.some((item) => item.externalKey === claim.externalKey) ||
            scoreRecordingCandidate(toEvidence(claim), null, candidate.recording) >= 70
        )?.recording
        return {
          provider: claim.provider,
          entityType: claim.entityType,
          externalKey: claim.externalKey,
          proposedRecordingId: proposedRecording?.id ?? null,
          score: best && proposedRecording?.id === best.recording.id ? best.score : claim.confidence,
          disposition: rejectedKeys.has(claim.externalKey) ? 'rejected' : 'candidate',
          payloadJson: JSON.stringify(claim),
          recordingCanonical: proposedRecording?.canonical ?? null
        } satisfies RecordingCandidateSuggestion
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 8)

    if (best && best.score >= 85 && (!next || best.score - next.score >= 8)) {
      const acceptedClaims = sortClaims(dedupedClaims.filter((claim) => claim.confidence >= 75))
      return {
        status: 'ready',
        assignmentMethod: 'heuristic',
        confidence: best.score,
        recordingId: best.recording.id,
        createRecording: null,
        chosenClaimId: null,
        chosenExternalKey: bestExternalKey(acceptedClaims) ?? heuristicCandidates[0]?.externalKey ?? null,
        acceptedClaims,
        candidates: heuristicCandidates.map((candidate, index) => ({
          ...candidate,
          disposition: index === 0 && candidate.proposedRecordingId === best.recording.id ? 'accepted' : candidate.disposition
        })),
        explanationJson: buildExplanation({ reason: 'heuristic_match', score: best.score }),
        recordingCanonical: best.recording.canonical,
        ...baseDecision
      }
    }

    if (canonical && evidenceScore >= 70) {
      const acceptedClaims = sortClaims(dedupedClaims.filter((claim) => claim.confidence >= 75))
      return {
        status: 'ready',
        assignmentMethod: 'heuristic',
        confidence: evidenceScore,
        recordingId: null,
        createRecording: {
          canonical,
          confidence: evidenceScore,
          reviewState: 'auto'
        },
        chosenClaimId: null,
        chosenExternalKey: bestExternalKey(acceptedClaims),
        acceptedClaims,
        candidates: heuristicCandidates,
        explanationJson: buildExplanation({ reason: 'new_recording', evidenceScore }),
        recordingCanonical: canonical,
        ...baseDecision
      }
    }

    return includeNeedsReview
      ? {
          status: 'needs_review',
          assignmentMethod: null,
          confidence: best?.score ?? evidenceScore,
          recordingId: null,
          createRecording: null,
          chosenClaimId: null,
          chosenExternalKey: null,
          acceptedClaims: [],
          candidates: heuristicCandidates,
          explanationJson: buildExplanation({
            reason: 'needs_review',
            bestScore: best?.score ?? null,
            evidenceScore
          }),
          recordingCanonical: canonical,
          ...baseDecision
        }
      : null
  }

  async identifyFile(filename: string): Promise<IdentificationDecision> {
    const absolutePath = this.deps.resolveMusicRelativePath(filename)
    await this.deps.fileAnalysisService.get(filename, absolutePath).catch(() => null)
    const [item, audioHash, rejectedKeys, tags] = await Promise.all([
      this.deps.collectionService.getItem(filename),
      this.deps.collectionService.readStoredAudioHash(filename),
      this.deps.collectionService.readRejectedIdentificationExternalKeys(filename),
      Promise.resolve(this.deps.taggerService.readTags(absolutePath))
    ])
    if (!item) {
      throw new Error(`File not found in collection: ${filename}`)
    }

    const parsed = toCanonical(parseImportFilename(filename))
    const rawTagArtist = cleanupArtistText(tags?.artist)
    const rawTagTitle = normalizeClaimFields({ title: tags?.title }).title
    const parsedTag = !rawTagArtist && rawTagTitle?.includes(' - ') ? parseImportFilename(rawTagTitle) : null
    const tagCanonical = tags
      ? {
          artist: rawTagArtist ?? cleanupArtistText(parsedTag?.artist),
          title: stripLeadingArtist(parsedTag?.title ?? rawTagTitle, rawTagArtist ?? parsedTag?.artist ?? parsed.artist),
          version: cleanupText(parsedTag?.version),
          year: cleanupText(tags.year)
        }
      : null
    const durationSeconds = item.parsedAudioAnalysis?.durationSeconds ?? null

    const claims = dedupeClaims(
      [
        parsed.artist || parsed.title
          ? {
              provider: 'filename',
              entityType: 'file_parse',
              externalKey: buildFilenameExternalKey(parsed),
              artist: parsed.artist,
              title: parsed.title,
              version: parsed.version,
              releaseTitle: null,
              trackPosition: null,
              year: parsed.year,
              durationSeconds,
              confidence: 60,
              rawJson: null
            }
          : null,
        tagCanonical?.artist || tagCanonical?.title
          ? {
              provider: 'tags',
              entityType: 'file_parse',
              externalKey: buildTagExternalKey({
                artist: tagCanonical.artist ?? '',
                title: tagCanonical.title ?? '',
                version: tagCanonical.version,
                trackPosition: tags?.trackPosition ?? null
              }),
              artist: tagCanonical.artist,
              title: tagCanonical.title,
              version: tagCanonical.version,
              releaseTitle: cleanupText(tags?.album),
              trackPosition: cleanupText(tags?.trackPosition),
              year: tagCanonical.year,
              durationSeconds,
              confidence: 72,
              rawJson: tags ? JSON.stringify(tags) : null
            }
          : null,
        tags?.discogsReleaseId
          ? {
              provider: 'discogs',
              entityType: 'release_track',
              externalKey: buildDiscogsExternalKey(tags.discogsReleaseId, tags.discogsTrackPosition, tags.title),
              artist: normalizeClaimFields({ artist: tagCanonical?.artist, title: tagCanonical?.title, version: null }).artist,
              title: normalizeClaimFields({ artist: tagCanonical?.artist, title: tagCanonical?.title, version: null }).title,
              version: normalizeClaimFields({ artist: tagCanonical?.artist, title: tagCanonical?.title, version: null }).version,
              releaseTitle: cleanupText(tags.album),
              trackPosition: cleanupText(tags.discogsTrackPosition),
              year: tagCanonical?.year ?? null,
              durationSeconds,
              confidence: 90,
              rawJson: tags ? JSON.stringify(tags) : null
            }
          : null,
        parseImportReviewClaim(item.importReview?.reviewJson)
      ].filter((value): value is RecordingClaimInput => Boolean(value))
    )

    const searchArtist = tagCanonical?.artist ?? parsed.artist ?? ''
    const searchTitle = tagCanonical?.title ?? parsed.title ?? ''
    const searchVersion = tagCanonical?.version ?? parsed.version ?? null
    const localDecision = await this.resolveClaims({
      claims,
      parsed,
      tagCanonical,
      audioHash: audioHash ?? null,
      durationSeconds,
      rejectedKeys,
      includeNeedsReview: false
    })
    if (localDecision) return localDecision

    if (searchArtist && searchTitle) {
      const settings = this.deps.getSettings()
      const [discogs, musicbrainz] = await Promise.all([
        this.deps.discogsMatchService
          .findTrack(settings, searchArtist, searchTitle, searchVersion, this.deps.onlineSearchService)
          .catch(() => ({ candidates: [] as Array<{ releaseId: number; releaseTitle: string; artist: string; title: string; version: string | null; trackPosition?: string | null; year?: string | null; durationSeconds?: number | null; score: number }> })),
        this.deps.musicbrainzService.searchRecordings(searchArtist, searchTitle, searchVersion).catch(() => [])
      ])
      for (const candidate of discogs.candidates.slice(0, 3)) {
        const normalized = normalizeClaimFields({
          artist: candidate.artist,
          title: candidate.title,
          version: candidate.version
        })
        claims.push({
          provider: 'discogs',
          entityType: 'release_track',
          externalKey: buildDiscogsExternalKey(candidate.releaseId, candidate.trackPosition ?? null, candidate.title),
          artist: normalized.artist,
          title: normalized.title,
          version: normalized.version,
          releaseTitle: cleanupText(candidate.releaseTitle),
          trackPosition: cleanupText(candidate.trackPosition),
          year: cleanupText(candidate.year),
          durationSeconds: candidate.durationSeconds ?? null,
          confidence: Math.min(100, Math.max(70, Math.round(candidate.score))),
          rawJson: JSON.stringify(candidate)
        })
      }
      for (const candidate of musicbrainz.slice(0, 3)) {
        const normalized = normalizeClaimFields({
          artist: candidate.artist,
          title: candidate.title,
          version: candidate.version
        })
        claims.push({
          provider: 'musicbrainz',
          entityType: 'recording',
          externalKey: buildMusicBrainzExternalKey(candidate.recordingId),
          artist: normalized.artist,
          title: normalized.title,
          version: normalized.version,
          releaseTitle: cleanupText(candidate.releaseTitle),
          trackPosition: null,
          year: cleanupText(candidate.year),
          durationSeconds: candidate.durationSeconds,
          confidence: Math.min(95, Math.max(55, Math.round(candidate.score))),
          rawJson: candidate.rawJson
        })
      }
    }

    return (await this.resolveClaims({
      claims,
      parsed,
      tagCanonical,
      audioHash: audioHash ?? null,
      durationSeconds,
      rejectedKeys,
      includeNeedsReview: true
    })) as IdentificationDecision
  }
}

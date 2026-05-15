import { extname } from 'node:path'
import type { CollectionService } from './collection-service.ts'
import type { FileAnalysisService } from './file-analysis-service.ts'
import type { AudioTags } from './tagger-service.ts'
import type { TaggerService } from './tagger-service.ts'
import { basenameOfFilename, normalizeFilename, normalizeSearchText } from './collection-service-helpers.ts'
import type { IdentificationDecision, RecordingClaimInput, SourceClaimMatch } from './recording-identity-service.ts'
import { parseImportFilename } from '../shared/import-filename.ts'
import { parseTrackTitle } from '../shared/track-title-parser.ts'

type LocalDecisionInput = {
  filename: string
  audioHash: string | null
  durationSeconds: number | null
  tags: AudioTags | null
}

type LocalRecordingIdentityDeps = {
  collectionService: CollectionService
  fileAnalysisService: FileAnalysisService
  taggerService: TaggerService
  resolveMusicRelativePath: (filename: string) => string
}

export type LocalRecordingAnalysisResult = {
  filename: string
  status: IdentificationDecision['status']
  assignmentMethod: IdentificationDecision['assignmentMethod']
  recordingId: number | null
  confidence: number | null
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? ''
  return normalized || null
}

function basenameTitle(filename: string): string {
  return basenameOfFilename(filename)
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ') || 'Untitled'
}

function hasStrongFilenameSignal(filename: string): boolean {
  return /(?:\s-\s|_-_)/.test(basenameOfFilename(filename))
}

function sameIdentity(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftNorm = normalizeSearchText(left ?? '')
  const rightNorm = normalizeSearchText(right ?? '')
  return !leftNorm || !rightNorm || leftNorm === rightNorm
}

function sameTrackPosition(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftNumber = left?.match(/\d+/)?.[0]?.replace(/^0+/, '') ?? null
  const rightNumber = right?.match(/\d+/)?.[0]?.replace(/^0+/, '') ?? null
  return leftNumber && rightNumber ? leftNumber === rightNumber : sameIdentity(left, right)
}

function isPlaceholderDiscogsPosition(value: string | null | undefined): boolean {
  return normalizeSearchText(value ?? '') === 'z'
}

function localClaim(provider: 'tags' | 'filename', filename: string, confidence: number, value: {
  artist: string | null
  title: string | null
  version: string | null
  year: string | null
  releaseTitle?: string | null
  trackPosition?: string | null
  rawJson?: string | null
}, durationSeconds: number | null): RecordingClaimInput {
  const normalized = normalizeFilename(filename)
  return {
    provider,
    entityType: 'file_parse',
    externalKey: `local:${provider}:${normalized}`,
    artist: value.artist,
    title: value.title,
    version: value.version,
    releaseTitle: value.releaseTitle ?? null,
    trackPosition: value.trackPosition ?? null,
    year: value.year,
    durationSeconds,
    confidence,
    rawJson: value.rawJson ?? null
  }
}

function discogsClaim(tags: AudioTags, canonical: { artist: string | null; title: string | null; version: string | null; year: string | null }, durationSeconds: number | null): RecordingClaimInput | null {
  if (!tags.discogsReleaseId) return null
  if (!tags.trackPosition && isPlaceholderDiscogsPosition(tags.discogsTrackPosition)) return null
  if (tags.discogsTrackPosition && tags.trackPosition && !sameTrackPosition(tags.discogsTrackPosition, tags.trackPosition)) return null
  const trackKey = normalizeSearchText(tags.discogsTrackPosition || tags.trackPosition || tags.title) || 'unknown'
  return {
    provider: 'discogs',
    entityType: 'release_track',
    externalKey: `discogs:release:${tags.discogsReleaseId}:track:${trackKey}`,
    artist: canonical.artist,
    title: canonical.title,
    version: canonical.version,
    releaseTitle: clean(tags.album),
    trackPosition: clean(tags.discogsTrackPosition ?? tags.trackPosition),
    year: canonical.year,
    durationSeconds,
    confidence: 90,
    rawJson: JSON.stringify(tags)
  }
}

function canonicalFitsLocalEvidence(decision: IdentificationDecision, matched: { artist: string | null; title: string | null; version: string | null } | null): boolean {
  const canonical = decision.recordingCanonical
  return !canonical || !matched || (
    sameIdentity(canonical.artist, matched.artist) &&
    sameIdentity(canonical.title, matched.title) &&
    sameIdentity(canonical.version, matched.version)
  )
}

function sourceMatchFitsLocalEvidence(decision: IdentificationDecision, match: SourceClaimMatch): boolean {
  return canonicalFitsLocalEvidence(decision, match.canonical)
}

function withoutConflictingClaims(decision: IdentificationDecision, blockedKeys: Set<string>): IdentificationDecision {
  const acceptedClaims = decision.acceptedClaims.filter((claim) => !blockedKeys.has(claim.externalKey))
  return {
    ...decision,
    acceptedClaims,
    chosenExternalKey: acceptedClaims.find((claim) => claim.provider === 'discogs')?.externalKey ??
      acceptedClaims.find((claim) => claim.provider === 'tags')?.externalKey ??
      acceptedClaims.find((claim) => claim.provider === 'filename')?.externalKey ??
      null
  }
}

export function buildLocalRecordingDecision({ filename, audioHash, durationSeconds, tags }: LocalDecisionInput): IdentificationDecision {
  const parsed = parseImportFilename(filename)
  const tagTitle = parseTrackTitle(tags?.title ?? '')
  const tagCanonical = tags && (clean(tags.artist) || clean(tagTitle.title))
    ? {
        artist: clean(tags.artist),
        title: clean(tagTitle.title),
        version: clean(tagTitle.version),
        year: clean(tags.year)
      }
    : null
  const filenameCanonical = parsed && hasStrongFilenameSignal(filename)
    ? { artist: clean(parsed.artist), title: clean(parsed.title), version: clean(parsed.version), year: clean(parsed.year) }
    : null
  const fallbackCanonical = {
    artist: 'Unknown Artist',
    title: basenameTitle(filename),
    version: null,
    year: null
  }
  const canonical = tagCanonical
    ? {
        artist: tagCanonical.artist ?? filenameCanonical?.artist ?? fallbackCanonical.artist,
        title: tagCanonical.title ?? filenameCanonical?.title ?? fallbackCanonical.title,
        version: tagCanonical.version ?? filenameCanonical?.version ?? null,
        year: tagCanonical.year ?? filenameCanonical?.year ?? null
      }
    : filenameCanonical ?? fallbackCanonical
  const confidence = tagCanonical ? 80 : filenameCanonical ? 65 : 35
  const tagClaim = tagCanonical && tags
    ? localClaim('tags', filename, 80, {
        ...tagCanonical,
        releaseTitle: tags.album,
        trackPosition: tags.trackPosition,
        rawJson: JSON.stringify(tags)
      }, durationSeconds)
    : null
  const filenameClaim = localClaim('filename', filename, filenameCanonical ? 60 : 35, filenameCanonical ?? fallbackCanonical, durationSeconds)
  const claims = [tags ? discogsClaim(tags, canonical, durationSeconds) : null, tagClaim, filenameClaim]
    .filter((claim): claim is RecordingClaimInput => Boolean(claim))

  return {
    status: 'ready',
    assignmentMethod: 'heuristic',
    confidence,
    recordingId: null,
    createRecording: { canonical, confidence, reviewState: 'auto' },
    audioHash,
    parsedArtist: filenameCanonical?.artist ?? null,
    parsedTitle: filenameCanonical?.title ?? null,
    parsedVersion: filenameCanonical?.version ?? null,
    parsedYear: filenameCanonical?.year ?? null,
    tagArtist: tagCanonical?.artist ?? null,
    tagTitle: tagCanonical?.title ?? null,
    tagVersion: tagCanonical?.version ?? null,
    chosenClaimId: null,
    chosenExternalKey: claims.find((claim) => claim.provider === 'discogs')?.externalKey ?? tagClaim?.externalKey ?? filenameClaim.externalKey,
    acceptedClaims: claims,
    candidates: [],
    explanationJson: JSON.stringify({ reason: 'local_only', source: tagCanonical ? 'tags' : filenameCanonical ? 'filename' : 'basename', ext: extname(filename).toLowerCase() }),
    recordingCanonical: canonical
  }
}

function withRecordingMatch(
  decision: IdentificationDecision,
  recordingId: number,
  assignmentMethod: NonNullable<IdentificationDecision['assignmentMethod']>,
  confidence: number,
  chosenExternalKey: string | null
): IdentificationDecision {
  return {
    ...decision,
    assignmentMethod,
    confidence,
    recordingId,
    createRecording: null,
    chosenExternalKey,
    candidates: decision.acceptedClaims.map((claim) => ({
      provider: claim.provider,
      entityType: claim.entityType,
      externalKey: claim.externalKey,
      proposedRecordingId: recordingId,
      score: confidence,
      disposition: 'accepted',
      payloadJson: JSON.stringify(claim),
      recordingCanonical: decision.recordingCanonical
    }))
  }
}

export class LocalRecordingIdentityService {
  private readonly deps: LocalRecordingIdentityDeps

  constructor(deps: LocalRecordingIdentityDeps) {
    this.deps = deps
  }

  async analyzeFile(filename: string): Promise<LocalRecordingAnalysisResult> {
    const snapshot = await this.deps.collectionService.readFileSnapshot(filename)
    if (!snapshot) throw new Error(`File not found in collection: ${filename}`)
    const absolutePath = this.deps.resolveMusicRelativePath(filename)
    const [analysis, tags] = await Promise.all([
      this.deps.fileAnalysisService.get(filename, absolutePath),
      Promise.resolve(this.deps.taggerService.readTags(absolutePath))
    ])
    const audioHash = await this.deps.collectionService.readStoredAudioHash(filename)
    await this.saveTags(filename, snapshot, tags)
    const baseDecision = buildLocalRecordingDecision({
      filename,
      audioHash,
      durationSeconds: analysis?.durationSeconds ?? null,
      tags
    })
    const decision = await this.attachExistingRecording(baseDecision)
    await this.deps.collectionService.saveIdentificationDecision(filename, {
      filesize: snapshot.filesize,
      mtimeMs: snapshot.mtimeMs,
      ...decision
    })
    return {
      filename,
      status: decision.status,
      assignmentMethod: decision.assignmentMethod,
      recordingId: decision.recordingId,
      confidence: decision.confidence
    }
  }

  private async attachExistingRecording(decision: IdentificationDecision): Promise<IdentificationDecision> {
    if (decision.audioHash) {
      const match = await this.deps.collectionService.findRecordingByAudioHash(decision.audioHash)
      if (match && canonicalFitsLocalEvidence(decision, match.canonical)) {
        return withRecordingMatch(decision, match.recordingId, 'audio_hash', 100, decision.chosenExternalKey)
      }
    }
    const sourceMatches = await this.deps.collectionService.findSourceClaimMatches(
      decision.acceptedClaims.map((claim) => claim.externalKey)
    )
    const incompatibleKeys = new Set(sourceMatches.filter((match) => !sourceMatchFitsLocalEvidence(decision, match)).map((match) => match.externalKey))
    const blockedKeys = new Set([...incompatibleKeys].filter((key) => !key.startsWith('local:')))
    const safeDecision = blockedKeys.size ? withoutConflictingClaims(decision, blockedKeys) : decision
    const best = sourceMatches
      .filter((match) => !incompatibleKeys.has(match.externalKey))
      .sort((left, right) => right.confidence - left.confidence)[0] ?? null
    return best
      ? withRecordingMatch(safeDecision, best.recordingId, 'source_claim', Math.max(85, best.confidence), best.externalKey)
      : safeDecision
  }

  private async saveTags(filename: string, snapshot: { filesize: number; mtimeMs: number }, tags: AudioTags | null): Promise<void> {
    const parsedTitle = parseTrackTitle(tags?.title ?? '')
    await this.deps.collectionService.saveFileTagState(filename, {
      filesize: snapshot.filesize,
      mtimeMs: snapshot.mtimeMs,
      source: tags ? 'file_tag_state' : 'none',
      artist: clean(tags?.artist),
      title: clean(parsedTitle.title),
      version: clean(parsedTitle.version),
      album: clean(tags?.album),
      year: clean(tags?.year),
      label: clean(tags?.label),
      catalogNumber: clean(tags?.catalogNumber),
      trackPosition: clean(tags?.trackPosition),
      discogsReleaseId: tags?.discogsReleaseId ?? null,
      discogsTrackPosition: clean(tags?.discogsTrackPosition),
      rawJson: tags ? JSON.stringify(tags) : null,
      errorMessage: null
    })
  }
}

import type { CollectionService } from '@djbrain/backend/collection-service'
import type { FileAnalysisService } from '@djbrain/backend/file-analysis-service'
import type { ImportService } from '@djbrain/backend/import-service'
import type { OnlineSearchService } from '@djbrain/backend/online-search-service'
import { buildDiscogsExternalKey } from '@djbrain/backend/recording-identity-service'
import type { AppSettings } from '@djbrain/backend/settings-store'
import type { SlskdService } from '@djbrain/backend/slskd-service'
import { HttpError } from './http.ts'
import { parseDurationString } from '@djbrain/shared/track-matcher'
import type { DiscogsReleaseDownloadResult, DiscogsReleaseDownloadTrackResult, RecordingCanonical, UpgradeCandidate } from '@djbrain/shared/api'
import { parseTrackTitle } from '@djbrain/shared/track-title-parser'
import { buildReleaseDownloadQueries, buildReleaseTrackReviewData, buildUpgradeCandidate, cleanupDiscogsArtist, compareUpgradeCandidates, toMusicRelativePath, waitForResolvedLocalPath } from './workflow-download-utils.ts'

export async function downloadDiscogsReleaseWorkflow({
  service,
  settings,
  releaseId,
  slskdService,
  importService,
  onlineSearchService,
  fileAnalysisService
}: {
  service: CollectionService
  settings: AppSettings
  releaseId: number
  slskdService: SlskdService
  importService: ImportService
  onlineSearchService: OnlineSearchService
  fileAnalysisService: FileAnalysisService
}): Promise<DiscogsReleaseDownloadResult> {
  if (!settings.slskdBaseURL || !settings.slskdApiKey) throw new HttpError(400, 'slskd is not configured.')
  const release = await onlineSearchService.getDiscogsEntity(settings, 'release', releaseId)
  if (release.type !== 'release') throw new HttpError(404, 'Discogs release not found.')

  const artist = release.artists.map(cleanupDiscogsArtist).join(', ')
  const results: DiscogsReleaseDownloadTrackResult[] = []
  for (const track of release.tracklist.filter((entry) => entry.title.trim())) {
    const parsed = parseTrackTitle(track.title)
    const canonical: RecordingCanonical = { artist, title: parsed.title.trim(), version: parsed.version, year: release.year ?? null }
    const durationSeconds = parseDurationString(track.duration ?? '')
    const baseResult = { position: track.position ?? null, artist, title: canonical.title ?? parsed.title.trim(), version: canonical.version, durationSeconds }
    try {
      let candidate: UpgradeCandidate | null = null
      for (const query of buildReleaseDownloadQueries(canonical)) {
        let searchId: string | null = null
        try {
          searchId = await slskdService.startSearch(settings, query)
          const search = await slskdService.waitForResults(settings, searchId)
          candidate =
            slskdService
              .extractCandidates(artist, canonical.title ?? parsed.title.trim(), canonical.version, search)
              .map((entry) => buildUpgradeCandidate(entry, durationSeconds))
              .sort(compareUpgradeCandidates)
              .find((entry) => !entry.isLocked && entry.speedClass !== 'different_edit_likely') ?? null
          if (candidate) break
        } finally {
          if (searchId) await slskdService.deleteSearch(settings, searchId).catch(() => {})
        }
      }
      if (!candidate) {
        results.push({ ...baseResult, filename: null, recordingId: null, status: 'no_results', message: 'No downloadable Soulseek matches.' })
        continue
      }

      await slskdService.downloadFile(settings, candidate.username, candidate.filename, candidate.size)
      const downloadState = await slskdService.waitForDownload(settings, candidate.username, candidate.filename)
      if (downloadState !== 'Completed') {
        results.push({ ...baseResult, filename: null, recordingId: null, status: 'download_error', message: downloadState === 'Timeout' ? 'Download timed out.' : 'Download failed.' })
        continue
      }

      const localPath = await waitForResolvedLocalPath(settings, importService, candidate.filename)
      if (!localPath) {
        results.push({ ...baseResult, filename: null, recordingId: null, status: 'download_error', message: 'Downloaded file was not found locally.' })
        continue
      }

      await service.syncNow()
      const filename = toMusicRelativePath(settings, localPath)
      await fileAnalysisService.get(filename, localPath).catch(() => null)
      const snapshot = await service.readFileSnapshot(filename)
      const item = await service.getItem(filename)
      if (!snapshot || !item) {
        results.push({ ...baseResult, filename, recordingId: null, status: 'identify_error', message: 'Downloaded file was not indexed.' })
        continue
      }

      const externalKey = buildDiscogsExternalKey(release.id, track.position ?? null, canonical.title)
      const matchedSource = (await service.findSourceClaimMatches([externalKey]))[0] ?? null
      const claim = {
        provider: 'discogs' as const,
        entityType: 'release_track' as const,
        externalKey,
        artist: canonical.artist,
        title: canonical.title,
        version: canonical.version,
        releaseTitle: release.title,
        trackPosition: track.position ?? null,
        year: canonical.year,
        durationSeconds,
        confidence: 100,
        rawJson: JSON.stringify({
          releaseId: release.id,
          releaseTitle: release.title,
          releaseUrl: release.externalUrl,
          trackPosition: track.position ?? null,
          trackTitle: track.title,
          duration: track.duration ?? null,
          formats: release.formats,
          labels: release.labels,
          catalogNumbers: release.catalogNumbers,
          country: release.country ?? null
        })
      }

      await service.saveIdentificationDecision(filename, {
        filesize: snapshot.filesize,
        mtimeMs: snapshot.mtimeMs,
        status: 'ready',
        assignmentMethod: matchedSource ? 'source_claim' : 'manual',
        confidence: 100,
        recordingId: matchedSource?.recordingId ?? null,
        createRecording: matchedSource ? null : { canonical, confidence: 100, reviewState: 'confirmed' },
        audioHash: item.fileAudioState?.audioHash ?? item.identification?.audioHash ?? null,
        durationSeconds: item.parsedAudioAnalysis?.durationSeconds ?? durationSeconds,
        parsedArtist: item.identification?.parsedArtist ?? canonical.artist,
        parsedTitle: item.identification?.parsedTitle ?? canonical.title,
        parsedVersion: item.identification?.parsedVersion ?? canonical.version,
        parsedYear: item.identification?.parsedYear ?? canonical.year,
        tagArtist: item.identification?.tagArtist ?? null,
        tagTitle: item.identification?.tagTitle ?? null,
        tagVersion: item.identification?.tagVersion ?? null,
        chosenClaimId: matchedSource?.claimId ?? null,
        chosenExternalKey: externalKey,
        acceptedClaims: [],
        candidates: [{
          provider: 'discogs',
          entityType: 'release_track',
          externalKey,
          proposedRecordingId: matchedSource?.recordingId ?? null,
          score: 100,
          disposition: 'candidate',
          payloadJson: JSON.stringify(claim),
          recordingCanonical: matchedSource?.canonical ?? canonical
        }],
        explanationJson: JSON.stringify({ reason: 'discogs_release_download', releaseId: release.id, trackPosition: track.position ?? null, releaseTitle: release.title }),
        recordingCanonical: matchedSource?.canonical ?? canonical,
        reviewData: buildReleaseTrackReviewData(release.id, release.title, release.externalUrl, matchedSource?.canonical ?? canonical, track, matchedSource?.recordingId ?? null)
      })

      const identified = await service.getItem(filename)
      const candidateId = identified?.identification?.candidates.find((entry) => entry.externalKey === externalKey)?.id ?? null
      const verified = await service.reviewIdentification(filename, 'accept', candidateId)
      results.push({ ...baseResult, filename, recordingId: verified?.recordingId ?? identified?.identification?.recordingId ?? matchedSource?.recordingId ?? null, status: 'verified', message: null })
    } catch (error) {
      results.push({ ...baseResult, filename: null, recordingId: null, status: 'identify_error', message: error instanceof Error ? error.message : 'Track processing failed.' })
    }
  }

  return {
    releaseId: release.id,
    releaseTitle: release.title,
    trackCount: results.length,
    verifiedCount: results.filter((entry) => entry.status === 'verified').length,
    results
  }
}

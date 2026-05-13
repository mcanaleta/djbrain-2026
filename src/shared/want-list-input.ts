import type { CollectionItemDetails, WantListAddInput } from './api.ts'
import { parseImportFilename } from './import-filename.ts'

function text(value: string | null | undefined): string | null {
  return value?.trim() || null
}

export function buildReplacementWantInput(item: CollectionItemDetails): WantListAddInput {
  const parsed = parseImportFilename(item.filename)
  const canonical = item.recordingCanonical
  const tags = item.tags
  return {
    wantKind: 'replacement',
    artist: text(canonical?.artist) ?? text(tags?.artist) ?? text(item.importReview?.parsedArtist) ?? parsed?.artist ?? 'Unknown Artist',
    title: text(canonical?.title) ?? text(tags?.title) ?? text(item.importReview?.parsedTitle) ?? parsed?.title ?? item.filename,
    version: text(canonical?.version) ?? text(tags?.version) ?? text(item.importReview?.parsedVersion) ?? parsed?.version ?? null,
    year: text(canonical?.year) ?? text(tags?.year) ?? text(item.importReview?.parsedYear) ?? parsed?.year ?? null,
    album: text(tags?.album),
    label: text(tags?.label),
    discogsReleaseId: tags?.discogsReleaseId ?? null,
    discogsTrackPosition: text(tags?.discogsTrackPosition),
    discogsEntityType: tags?.discogsReleaseId ? 'release' : null,
    sourceCollectionFilename: item.filename,
    targetDownloadCount: 3,
    autoDownloadEnabled: true
  }
}

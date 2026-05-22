import type { CollectionItem, RecordingDetails } from '@djbrain/shared/api'
import { deriveTrackSummaryFromFilename } from '../../lib/music-file'

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\b(vs|feat|featuring)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function words(value: string): string[] {
  return normalizeText(value).split(' ').filter(Boolean)
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0
  if (!left) return right.length
  if (!right) return left.length
  const prev = Array.from({ length: right.length + 1 }, (_, i) => i)
  const next = new Array(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    next[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = next[j]
  }
  return prev[right.length]
}

function similarityScore(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.8
  const distance = editDistance(a, b)
  const edit = 1 - distance / Math.max(a.length, b.length, 1)
  const leftWords = new Set(words(a))
  const rightWords = new Set(words(b))
  let overlap = 0
  for (const word of leftWords) if (rightWords.has(word)) overlap += 1
  const token = overlap / Math.max(leftWords.size, rightWords.size, 1)
  return Math.max(0, Math.min(1, Math.max(edit, token)))
}

function itemMeta(item: CollectionItem): { artist: string; title: string; version: string; year: string; filename: string } {
  const fallback = deriveTrackSummaryFromFilename(item.filename)
  return {
    artist: item.recordingCanonical?.artist ?? item.importArtist ?? fallback.artist,
    title: item.recordingCanonical?.title ?? item.importTitle ?? fallback.title,
    version: item.recordingCanonical?.version ?? item.importVersion ?? '',
    year: item.recordingCanonical?.year ?? item.importYear ?? fallback.year,
    filename: item.filename
  }
}

export function buildImportRecordSearchQuery(recording: RecordingDetails | null): string {
  const title = recording?.canonical.title?.trim() ?? ''
  const artist = recording?.canonical.artist?.trim() ?? ''
  return title || [artist, recording?.canonical.version].filter(Boolean).join(' ')
}

export function scoreImportRecordLocalMatch(item: CollectionItem, recording: RecordingDetails): number {
  const meta = itemMeta(item)
  const artist = similarityScore(meta.artist, recording.canonical.artist)
  const title = similarityScore(meta.title, recording.canonical.title)
  const version = recording.canonical.version ? similarityScore(meta.version, recording.canonical.version) : meta.version ? 0.4 : 1
  const year = recording.canonical.year && meta.year && recording.canonical.year === meta.year ? 1 : 0
  const filename = similarityScore(meta.filename, `${recording.canonical.artist ?? ''} ${recording.canonical.title ?? ''} ${recording.canonical.version ?? ''}`)
  return (
    (item.recordingId === recording.id ? 1000 : 0) +
    artist * 160 +
    title * 220 +
    version * 80 +
    year * 20 +
    filename * 40
  )
}

import type { CollectionItem, RecordingDetails } from '../../../../shared/api'

export function recordTitle(recording: RecordingDetails): string {
  const main = [recording.canonical.artist, recording.canonical.title].filter(Boolean).join(' - ')
  const version = recording.canonical.version ? ` (${recording.canonical.version})` : ''
  return `${main || `Record ${recording.id}`}${version}`
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function isRiskyAssign(item: CollectionItem, recording: RecordingDetails): boolean {
  if (item.recordingId != null && item.recordingId !== recording.id) return true
  const artistMatches = !item.recordingCanonical?.artist || normalizeText(item.recordingCanonical.artist) === normalizeText(recording.canonical.artist)
  const titleMatches = !item.recordingCanonical?.title || normalizeText(item.recordingCanonical.title) === normalizeText(recording.canonical.title)
  const versionMatches = item.recordingCanonical?.version == null || normalizeText(item.recordingCanonical.version) === normalizeText(recording.canonical.version)
  return !(artistMatches && titleMatches && versionMatches)
}

export function buildAssignConfirmText(item: CollectionItem, recording: RecordingDetails): string[] {
  const lines = []
  if (item.recordingId != null && item.recordingId !== recording.id) lines.push(`This file is already assigned to record #${item.recordingId}.`)
  if (isRiskyAssign(item, recording)) lines.push('The local file metadata does not match this record cleanly.')
  lines.push(`Add "${item.filename}" to "${recordTitle(recording)}"?`)
  return lines
}

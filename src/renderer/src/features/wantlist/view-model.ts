import type { Dispatch, SetStateAction } from 'react'
import type {
  SlskdCandidate,
  WantListAddInput,
  WantListItem
} from '../../../../shared/api'
import { getErrorMessage } from '../../lib/error-utils'

export type WantListEditState = {
  artist: string
  title: string
  version: string
  length: string
  album: string
  label: string
}

export type WantListPipelineStatus = WantListItem['pipelineStatus']

export const WANT_LIST_STATUS_LABEL: Record<WantListPipelineStatus, string> = {
  idle: 'Pending',
  searching: 'Searching…',
  results_ready: 'Results ready',
  no_results: 'No results',
  downloading: 'Downloading…',
  downloaded: 'Downloaded',
  identifying: 'Identifying…',
  needs_review: 'Needs review',
  importing: 'Importing…',
  imported: 'Imported',
  import_error: 'Import error',
  error: 'Error'
}

export const WANT_LIST_STATUS_CLASS: Record<WantListPipelineStatus, string> = {
  idle: 'border-zinc-700 text-zinc-400',
  searching: 'border-amber-700/60 text-amber-300',
  results_ready: 'border-emerald-700/60 text-emerald-300',
  no_results: 'border-zinc-700 text-zinc-500',
  downloading: 'border-blue-700/60 text-blue-300',
  downloaded: 'border-emerald-600/60 text-emerald-200',
  identifying: 'border-amber-700/60 text-amber-300',
  needs_review: 'border-amber-600/60 text-amber-200',
  importing: 'border-blue-700/60 text-blue-300',
  imported: 'border-emerald-600/60 text-emerald-300',
  import_error: 'border-red-700/60 text-red-300',
  error: 'border-red-700/60 text-red-300'
}

export function formatWantListError(
  error: unknown,
  fallback = 'Unexpected want-list error'
): string {
  return getErrorMessage(error, fallback)
}

export function buildSavedResearchQuery(item: WantListItem): string {
  return [item.artist, item.title, item.version].filter(Boolean).join(' ')
}

export function toWantListEditState(item: WantListItem): WantListEditState {
  return {
    artist: item.artist,
    title: item.title,
    version: item.version ?? '',
    length: item.length ?? '',
    album: item.album ?? '',
    label: item.label ?? ''
  }
}

export function toWantListAddInput(state: WantListEditState): WantListAddInput {
  return {
    artist: state.artist,
    title: state.title,
    version: state.version.trim() || null,
    length: state.length.trim() || null,
    album: state.album.trim() || null,
    label: state.label.trim() || null
  }
}

export function isWantListItemBusy(item: WantListItem): boolean {
  return (
    item.pipelineStatus === 'searching' ||
    item.pipelineStatus === 'downloading' ||
    item.pipelineStatus === 'identifying' ||
    item.pipelineStatus === 'importing'
  )
}

export function canResetWantListItem(item: WantListItem): boolean {
  return (
    item.pipelineStatus === 'downloaded' ||
    item.pipelineStatus === 'no_results' ||
    item.pipelineStatus === 'error'
  )
}

export function getSoulseekActionKey(candidate: SlskdCandidate): string {
  return `download:${candidate.username}:${candidate.filename}`
}

export function updateWantListEditState(
  setter: Dispatch<SetStateAction<WantListEditState | null>>,
  field: keyof WantListEditState,
  value: string
): void {
  setter((current) => (current ? { ...current, [field]: value } : current))
}

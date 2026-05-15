import { isSupportedAudioFile, normalizeFilename, normalizeRelativeFolderPath } from './collection-service-helpers.ts'

export type DropboxFileSourceConfig = {
  accessToken: string
  musicPath: string
  songsFolderPath: string
  downloadFolderPaths: string[]
}

export type DropboxEntry = {
  '.tag': string
  path_display?: string
  path_lower?: string
  server_modified?: string
  client_modified?: string
  size?: number
}

export type DropboxFileState = {
  filename: string
  filesize: number
  mtimeMs: number
}

type Env = Record<string, string | undefined>
type Settings = Pick<DropboxFileSourceConfig, 'songsFolderPath' | 'downloadFolderPaths'> & { musicFolderPath?: string }
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const normalizeDropboxPath = (value: string): string => {
  const normalized = normalizeFilename(value.trim()).replace(/\/+$/, '')
  if (!normalized || normalized === '/') return ''
  return `/${normalized.replace(/^\/+/, '')}`
}

const joinDropboxPath = (root: string, child: string): string => {
  const base = normalizeDropboxPath(root)
  const relative = normalizeRelativeFolderPath(child)
  return normalizeDropboxPath(`${base}/${relative}`)
}

export function readDropboxFileSourceConfig(settings: Settings, env: Env = process.env): DropboxFileSourceConfig | null {
  if ((env.DJBRAIN_FILE_ACCESS_MODE ?? '').trim().toLowerCase() !== 'dropbox') return null
  const accessToken = env.DJBRAIN_DROPBOX_ACCESS_TOKEN?.trim()
  if (!accessToken) throw new Error('DJBRAIN_DROPBOX_ACCESS_TOKEN is required when DJBRAIN_FILE_ACCESS_MODE=dropbox.')
  return {
    accessToken,
    musicPath: normalizeDropboxPath(env.DJBRAIN_DROPBOX_MUSIC_PATH?.trim() || settings.musicFolderPath || ''),
    songsFolderPath: normalizeRelativeFolderPath(settings.songsFolderPath || 'songs'),
    downloadFolderPaths: settings.downloadFolderPaths.map(normalizeRelativeFolderPath).filter(Boolean)
  }
}

export function buildDropboxScanPaths(config: DropboxFileSourceConfig): string[] {
  return [...new Set([config.songsFolderPath, ...config.downloadFolderPaths].filter(Boolean).map((path) => joinDropboxPath(config.musicPath, path)))]
}

export function dropboxEntriesToFileStates(config: DropboxFileSourceConfig, entries: DropboxEntry[]): DropboxFileState[] {
  const musicPath = normalizeDropboxPath(config.musicPath)
  const rootParts = musicPath ? musicPath.split('/').filter(Boolean).length : 0
  return entries.flatMap((entry) => {
    if (entry['.tag'] !== 'file' || typeof entry.size !== 'number') return []
    const displayPath = normalizeDropboxPath(entry.path_display || entry.path_lower || '')
    if (!displayPath || !isSupportedAudioFile(displayPath)) return []
    const lowerPath = displayPath.toLowerCase()
    const lowerMusic = musicPath.toLowerCase()
    if (lowerMusic && lowerPath !== lowerMusic && !lowerPath.startsWith(`${lowerMusic}/`)) return []
    const filename = displayPath.split('/').filter(Boolean).slice(rootParts).join('/')
    if (!filename) return []
    const modified = Date.parse(entry.server_modified || entry.client_modified || '')
    return [{ filename, filesize: entry.size, mtimeMs: Number.isFinite(modified) ? modified : 0 }]
  }).sort((left, right) => left.filename.localeCompare(right.filename))
}

async function postDropbox<T>(path: string, accessToken: string, body: unknown, fetcher: FetchLike): Promise<T> {
  const response = await fetcher(`https://api.dropboxapi.com/2/files/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`Dropbox ${path} failed (${response.status}): ${await response.text()}`)
  return await response.json() as T
}

export async function listDropboxAudioFiles(config: DropboxFileSourceConfig, fetcher: FetchLike = fetch): Promise<DropboxFileState[]> {
  const entries: DropboxEntry[] = []
  for (const path of buildDropboxScanPaths(config)) {
    let page = await postDropbox<{ entries: DropboxEntry[]; cursor: string; has_more: boolean }>(
      'list_folder',
      config.accessToken,
      { path, recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: 2000 },
      fetcher
    )
    entries.push(...page.entries)
    while (page.has_more) {
      page = await postDropbox('list_folder/continue', config.accessToken, { cursor: page.cursor }, fetcher)
      entries.push(...page.entries)
    }
  }
  return dropboxEntriesToFileStates(config, entries)
}

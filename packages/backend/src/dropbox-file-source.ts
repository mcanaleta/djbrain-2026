import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

export function readDropboxFileSourceConfig(settings: Settings, env: Env = process.env, rcloneConfigText?: string): DropboxFileSourceConfig | null {
  if ((env.DJBRAIN_FILE_ACCESS_MODE ?? '').trim().toLowerCase() !== 'dropbox') return null
  const accessToken = readDropboxAccessToken(env, rcloneConfigText)
  if (!accessToken) throw new Error('DJBRAIN_DROPBOX_ACCESS_TOKEN is required when DJBRAIN_FILE_ACCESS_MODE=dropbox.')
  return {
    accessToken,
    musicPath: normalizeDropboxPath(env.DJBRAIN_DROPBOX_MUSIC_PATH?.trim() || settings.musicFolderPath || ''),
    songsFolderPath: normalizeRelativeFolderPath(settings.songsFolderPath || 'songs'),
    downloadFolderPaths: settings.downloadFolderPaths.map(normalizeRelativeFolderPath).filter(Boolean)
  }
}

export function readDropboxAccessToken(env: Env = process.env, rcloneConfigText?: string): string | null {
  const explicit = env.DJBRAIN_DROPBOX_ACCESS_TOKEN?.trim()
  if (explicit) return explicit
  const text = rcloneConfigText ?? readOptionalFile(env.DJBRAIN_DROPBOX_RCLONE_CONFIG?.trim())
  if (!text) return null
  const remote = env.DJBRAIN_DROPBOX_RCLONE_REMOTE?.trim() || 'dropbox'
  const tokenJson = readIniValue(text, remote, 'token')
  if (!tokenJson) return null
  try {
    const token = JSON.parse(tokenJson) as { access_token?: unknown }
    return typeof token.access_token === 'string' && token.access_token.trim() ? token.access_token.trim() : null
  } catch {
    return null
  }
}

function readOptionalFile(path: string | undefined): string | null {
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readIniValue(text: string, section: string, key: string): string | null {
  let inSection = false
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    const header = trimmed.match(/^\[([^\]]+)\]$/u)
    if (header) {
      inSection = header[1] === section
      continue
    }
    if (!inSection || !trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const index = trimmed.indexOf('=')
    if (index < 0 || trimmed.slice(0, index).trim() !== key) continue
    return trimmed.slice(index + 1).trim()
  }
  return null
}

export function buildDropboxScanPaths(config: DropboxFileSourceConfig): string[] {
  return [...new Set([config.songsFolderPath, ...config.downloadFolderPaths].filter(Boolean).map((path) => joinDropboxPath(config.musicPath, path)))]
}

export function dropboxPathForFilename(config: DropboxFileSourceConfig, filename: string): string {
  return joinDropboxPath(config.musicPath, normalizeFilename(filename).replace(/^\/+/, ''))
}

export function dropboxCachePathForFilename(cacheRoot: string, filename: string): string {
  const root = resolve(cacheRoot)
  const target = resolve(root, normalizeFilename(filename).replace(/^\/+/, ''))
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Dropbox cache target is outside cache root.')
  return target
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

export async function downloadDropboxFileToCache(
  config: DropboxFileSourceConfig,
  filename: string,
  cacheRoot: string,
  expectedSize?: number | null,
  fetcher: FetchLike = fetch
): Promise<string> {
  const cachePath = dropboxCachePathForFilename(cacheRoot, filename)
  const cached = await stat(cachePath).catch(() => null)
  if (cached?.isFile() && (!expectedSize || cached.size === expectedSize)) return cachePath
  await mkdir(dirname(cachePath), { recursive: true })
  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`
  const response = await fetcher('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPathForFilename(config, filename) })
    }
  })
  if (!response.ok || !response.body) throw new Error(`Dropbox download failed (${response.status}): ${await response.text()}`)
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
    await rename(tempPath, cachePath)
    return cachePath
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

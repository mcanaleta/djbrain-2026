import { isAbsolute, relative, resolve } from 'node:path'

export type AppSettings = {
  musicFolderPath: string
  songsFolderPath: string
  downloadFolderPaths: string[]
  slskdBaseURL: string
  slskdApiKey: string
  discogsUserToken: string
  grokApiKey: string
  serperApiKey: string
  youtubeApiKey: string
}

const DEFAULT_SETTINGS: AppSettings = {
  musicFolderPath: '',
  songsFolderPath: '',
  downloadFolderPaths: [],
  slskdBaseURL: 'http://localhost:5030',
  slskdApiKey: '',
  discogsUserToken: '',
  grokApiKey: '',
  serperApiKey: '',
  youtubeApiKey: ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePath(value: unknown): string {
  const normalized = normalizeString(value).replace(/[\\/]+$/, '')
  return normalized
}

function normalizeRelativePathToMusic(rawPath: unknown, musicFolderPath: string): string | null {
  const cleanedPath = normalizeString(rawPath)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
  if (!cleanedPath) {
    return null
  }

  if (isAbsolute(cleanedPath)) {
    if (!musicFolderPath) {
      return null
    }

    const resolvedMusicRoot = resolve(musicFolderPath)
    const resolvedDownload = resolve(cleanedPath)
    const relativePath = relative(resolvedMusicRoot, resolvedDownload).replace(/[\\/]+/g, '/')
    if (!relativePath || relativePath.startsWith('../') || relativePath === '..') {
      return null
    }
    if (relativePath === '.') {
      return ''
    }
    return relativePath
  }

  const normalizedRelative = cleanedPath
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/[\\/]+/g, '/')
  if (!normalizedRelative || normalizedRelative === '.' || normalizedRelative.startsWith('../')) {
    return null
  }
  return normalizedRelative
}

function normalizeDownloadRelativePath(rawPath: unknown, musicFolderPath: string): string | null {
  const normalized = normalizeRelativePathToMusic(rawPath, musicFolderPath)
  return normalized || null
}

function normalizeDownloadFolderPaths(value: unknown, musicFolderPath: string): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const output: string[] = []
  for (const item of value) {
    const pathValue = normalizeDownloadRelativePath(item, musicFolderPath)
    if (!pathValue || seen.has(pathValue)) {
      continue
    }
    seen.add(pathValue)
    output.push(pathValue)
  }
  return output
}

function applyEnvOverrides(settings: Record<string, unknown>): Record<string, unknown> {
  const ENV_MAP: Record<string, string> = {
    DJBRAIN_MUSIC_FOLDER_PATH: 'musicFolderPath',
    DJBRAIN_SONGS_FOLDER_PATH: 'songsFolderPath',
    DJBRAIN_DOWNLOAD_FOLDER_PATHS: 'downloadFolderPaths',
    DJBRAIN_SLSKD_BASE_URL: 'slskdBaseURL',
    DJBRAIN_SLSKD_API_KEY: 'slskdApiKey',
    DJBRAIN_DISCOGS_USER_TOKEN: 'discogsUserToken',
    DJBRAIN_GROK_API_KEY: 'grokApiKey',
    DJBRAIN_SERPER_API_KEY: 'serperApiKey',
    DJBRAIN_YOUTUBE_API_KEY: 'youtubeApiKey'
  }

  const result = { ...settings }
  for (const [envKey, settingKey] of Object.entries(ENV_MAP)) {
    const envValue = process.env[envKey]
    if (typeof envValue === 'string' && envValue.trim()) {
      if (settingKey === 'downloadFolderPaths') {
        result[settingKey] = envValue.split(',').map((s) => s.trim()).filter(Boolean)
      } else {
        result[settingKey] = envValue.trim()
      }
    }
  }
  return result
}

function normalizeSettings(value: unknown): AppSettings {
  const source = isRecord(value) ? value : {}
  const slskdBaseURL = normalizeString(source.slskdBaseURL)
  const slskdApiKey = normalizeString(source.slskdApiKey)
  const discogsUserToken = normalizeString(source.discogsUserToken)
  const grokApiKey = normalizeString(source.grokApiKey)
  const serperApiKey = normalizeString(source.serperApiKey)
  const youtubeApiKey = normalizeString(source.youtubeApiKey)
  const musicFolderPath = normalizePath(source.musicFolderPath)
  const songsFolderPath =
    normalizeRelativePathToMusic(source.songsFolderPath, musicFolderPath) ?? ''

  return {
    musicFolderPath,
    songsFolderPath,
    downloadFolderPaths: normalizeDownloadFolderPaths(source.downloadFolderPaths, musicFolderPath),
    slskdBaseURL: slskdBaseURL || DEFAULT_SETTINGS.slskdBaseURL,
    slskdApiKey,
    discogsUserToken,
    grokApiKey,
    serperApiKey,
    youtubeApiKey
  }
}

export function readSettings(): AppSettings {
  return normalizeSettings(applyEnvOverrides({}))
}

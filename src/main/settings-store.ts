import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

export type AppPaths = {
  userDataPath: string
  settingsFilePath: string
  dataDirPath: string
  databaseFilePath: string
  cacheDirPath: string
  logsDirPath: string
}

export type SettingsSnapshot = {
  settings: AppSettings
  appPaths: AppPaths
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

// Environment variable overrides (DJBRAIN_* prefix).
// Non-empty env vars take precedence over file-based settings.
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

function pickKnownSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) {
    return {}
  }

  const patch: Partial<AppSettings> = {}
  if ('musicFolderPath' in value) patch.musicFolderPath = normalizePath(value.musicFolderPath)
  if ('songsFolderPath' in value) patch.songsFolderPath = normalizePath(value.songsFolderPath)
  if ('downloadFolderPaths' in value) {
    patch.downloadFolderPaths = Array.isArray(value.downloadFolderPaths)
      ? value.downloadFolderPaths
      : []
  }
  if ('slskdBaseURL' in value) {
    patch.slskdBaseURL = normalizeString(value.slskdBaseURL) || DEFAULT_SETTINGS.slskdBaseURL
  }
  if ('slskdApiKey' in value) {
    patch.slskdApiKey = normalizeString(value.slskdApiKey)
  }
  if ('discogsUserToken' in value) {
    patch.discogsUserToken = normalizeString(value.discogsUserToken)
  }
  if ('grokApiKey' in value) {
    patch.grokApiKey = normalizeString(value.grokApiKey)
  }
  if ('serperApiKey' in value) {
    patch.serperApiKey = normalizeString(value.serperApiKey)
  }
  if ('youtubeApiKey' in value) {
    patch.youtubeApiKey = normalizeString(value.youtubeApiKey)
  }

  return patch
}

export class SettingsStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  private readonly appPaths: AppPaths

  constructor(userDataPath: string) {
    const dataDirPath = join(userDataPath, 'data')
    this.appPaths = {
      userDataPath,
      settingsFilePath: join(userDataPath, 'settings.json'),
      dataDirPath,
      databaseFilePath: join(dataDirPath, 'djbrain.sqlite'),
      cacheDirPath: join(userDataPath, 'cache'),
      logsDirPath: join(userDataPath, 'logs')
    }
  }

  public async init(): Promise<void> {
    await Promise.all([
      mkdir(this.appPaths.userDataPath, { recursive: true }),
      mkdir(this.appPaths.dataDirPath, { recursive: true }),
      mkdir(this.appPaths.cacheDirPath, { recursive: true }),
      mkdir(this.appPaths.logsDirPath, { recursive: true })
    ])

    let fileSettings: unknown = {}
    try {
      const fileContent = await readFile(this.appPaths.settingsFilePath, 'utf-8')
      fileSettings = JSON.parse(fileContent)
    } catch {
      // No settings file yet — start from defaults
    }
    const merged = applyEnvOverrides(isRecord(fileSettings) ? fileSettings : {})
    this.settings = normalizeSettings(merged)
    await this.persist()
  }

  public snapshot(): SettingsSnapshot {
    return {
      settings: {
        musicFolderPath: this.settings.musicFolderPath,
        songsFolderPath: this.settings.songsFolderPath,
        downloadFolderPaths: [...this.settings.downloadFolderPaths],
        slskdBaseURL: this.settings.slskdBaseURL,
        slskdApiKey: this.settings.slskdApiKey,
        discogsUserToken: this.settings.discogsUserToken,
        grokApiKey: this.settings.grokApiKey,
        serperApiKey: this.settings.serperApiKey,
        youtubeApiKey: this.settings.youtubeApiKey
      },
      appPaths: { ...this.appPaths }
    }
  }

  public async update(patchValue: unknown): Promise<SettingsSnapshot> {
    const patch = pickKnownSettingsPatch(patchValue)
    this.settings = normalizeSettings({ ...this.settings, ...patch })
    await this.persist()
    return this.snapshot()
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.appPaths.settingsFilePath,
      JSON.stringify(this.settings, null, 2) + '\n',
      'utf-8'
    )
  }
}

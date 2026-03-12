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
}

export type AppPaths = {
  userDataPath: string
  settingsFilePath: string
  windowStateFilePath: string
  dataDirPath: string
  databaseFilePath: string
  cacheDirPath: string
  logsDirPath: string
}

export type SettingsSnapshot = {
  settings: AppSettings
  appPaths: AppPaths
}

export type WindowState = {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  musicFolderPath: '',
  songsFolderPath: '',
  downloadFolderPaths: [],
  slskdBaseURL: 'http://localhost:5030',
  slskdApiKey: '',
  discogsUserToken: '',
  grokApiKey: '',
  serperApiKey: ''
}

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 900,
  height: 670,
  isMaximized: false
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

function normalizeSettings(value: unknown): AppSettings {
  const source = isRecord(value) ? value : {}
  const slskdBaseURL = normalizeString(source.slskdBaseURL)
  const slskdApiKey = normalizeString(source.slskdApiKey)
  const discogsUserToken = normalizeString(source.discogsUserToken)
  const grokApiKey = normalizeString(source.grokApiKey)
  const serperApiKey = normalizeString(source.serperApiKey)
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
    serperApiKey
  }
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeWindowState(value: unknown): WindowState {
  const source = isRecord(value) ? value : {}
  const width = Math.max(toFiniteNumber(source.width) ?? DEFAULT_WINDOW_STATE.width, 640)
  const height = Math.max(toFiniteNumber(source.height) ?? DEFAULT_WINDOW_STATE.height, 480)
  const x = toFiniteNumber(source.x) ?? undefined
  const y = toFiniteNumber(source.y) ?? undefined
  const isMaximized = source.isMaximized === true

  return {
    width,
    height,
    x,
    y,
    isMaximized
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

  return patch
}

export class SettingsStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  private windowState: WindowState = { ...DEFAULT_WINDOW_STATE }

  private readonly appPaths: AppPaths

  constructor(userDataPath: string) {
    const dataDirPath = join(userDataPath, 'data')
    this.appPaths = {
      userDataPath,
      settingsFilePath: join(userDataPath, 'settings.json'),
      windowStateFilePath: join(userDataPath, 'window-state.json'),
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

    try {
      const fileContent = await readFile(this.appPaths.settingsFilePath, 'utf-8')
      this.settings = normalizeSettings(JSON.parse(fileContent))
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
      await this.persist()
    }

    try {
      const fileContent = await readFile(this.appPaths.windowStateFilePath, 'utf-8')
      this.windowState = normalizeWindowState(JSON.parse(fileContent))
    } catch {
      this.windowState = { ...DEFAULT_WINDOW_STATE }
      await this.persistWindowState()
    }

    await Promise.all([this.persist(), this.persistWindowState()])
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
        serperApiKey: this.settings.serperApiKey
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

  public getWindowState(): WindowState {
    return { ...this.windowState }
  }

  public async saveWindowState(value: unknown): Promise<void> {
    this.windowState = normalizeWindowState(value)
    await this.persistWindowState()
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.appPaths.settingsFilePath,
      JSON.stringify(this.settings, null, 2) + '\n',
      'utf-8'
    )
  }

  private async persistWindowState(): Promise<void> {
    await writeFile(
      this.appPaths.windowStateFilePath,
      JSON.stringify(this.windowState, null, 2) + '\n',
      'utf-8'
    )
  }
}

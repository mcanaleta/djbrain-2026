import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  type OpenDialogOptions
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { SettingsStore, type WindowState } from './settings-store'
import { CollectionService, type WantListItem } from './collection-service'
import { OnlineSearchService } from './online-search-service'
import { GrokSearchService } from './grok-search-service'
import { SlskdService } from './slskd-service'

let mainWindow: BrowserWindow | null = null
let settingsStore: SettingsStore | null = null
let collectionService: CollectionService | null = null
const onlineSearchService = new OnlineSearchService()
const grokSearchService = new GrokSearchService()
const slskdService = new SlskdService()

function emitWantListUpdated(item: WantListItem): void {
  mainWindow?.webContents.send('want-list:item-updated', item)
}

async function runSearchPipeline(item: WantListItem): Promise<void> {
  if (!collectionService || !settingsStore) return
  const settings = settingsStore.snapshot().settings
  if (!settings.slskdBaseURL || !settings.slskdApiKey) return

  try {
    const query = slskdService.buildSearchQuery(item.artist, item.title, item.version)
    const searchId = await slskdService.startSearch(settings, query)
    const updated1 = collectionService.wantListUpdatePipeline(item.id, {
      pipelineStatus: 'searching',
      searchId,
      pipelineError: null
    })
    if (updated1) emitWantListUpdated(updated1)

    const search = await slskdService.waitForResults(settings, searchId)
    const candidates = slskdService.extractCandidates(item.artist, item.title, item.version, search)
    const updated2 = collectionService.wantListUpdatePipeline(item.id, {
      pipelineStatus: candidates.length > 0 ? 'results_ready' : 'no_results',
      searchResultCount: candidates.length,
      bestCandidatesJson: candidates.length > 0 ? JSON.stringify(candidates) : null
    })
    if (updated2) emitWantListUpdated(updated2)

    // Note: search is intentionally left in slskd (not deleted) so the user can inspect it
  } catch (error) {
    const updated = collectionService.wantListUpdatePipeline(item.id, {
      pipelineStatus: 'error',
      pipelineError: error instanceof Error ? error.message : 'Search failed'
    })
    if (updated) emitWantListUpdated(updated)
  }
}

async function runDownloadPipeline(
  itemId: number,
  username: string,
  filename: string,
  size: number
): Promise<void> {
  if (!collectionService || !settingsStore) return
  const settings = settingsStore.snapshot().settings

  try {
    await slskdService.downloadFile(settings, username, filename, size)
    const updated1 = collectionService.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'downloading',
      downloadUsername: username,
      downloadFilename: filename,
      pipelineError: null
    })
    if (updated1) emitWantListUpdated(updated1)

    const result = await slskdService.waitForDownload(settings, username, filename)
    const updated2 = collectionService.wantListUpdatePipeline(itemId, {
      pipelineStatus: result === 'Completed' ? 'downloaded' : 'error',
      pipelineError:
        result !== 'Completed'
          ? result === 'Timeout'
            ? 'Download timed out'
            : 'Download failed or was cancelled'
          : null
    })
    if (updated2) emitWantListUpdated(updated2)
  } catch (error) {
    const updated = collectionService.wantListUpdatePipeline(itemId, {
      pipelineStatus: 'error',
      pipelineError: error instanceof Error ? error.message : 'Download failed'
    })
    if (updated) emitWantListUpdated(updated)
  }
}

type SlskdConnectionTestInput = {
  baseURL: string
  apiKey: string
}

type SlskdConnectionTestResult = {
  ok: boolean
  status: number | null
  endpoint: string | null
  message: string
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected request error'
}

function normalizeBaseURL(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim().replace(/\/+$/, '')
}

function normalizeApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function intersectsVisibleDisplay(state: WindowState): boolean {
  if (typeof state.x !== 'number' || typeof state.y !== 'number') {
    return true
  }

  const bounds = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height
  }
  const workArea = screen.getDisplayMatching(bounds).workArea

  return !(
    bounds.x + bounds.width < workArea.x + 80 ||
    bounds.y + bounds.height < workArea.y + 80 ||
    bounds.x > workArea.x + workArea.width - 80 ||
    bounds.y > workArea.y + workArea.height - 80
  )
}

function resolveWindowState(): WindowState {
  const fallback: WindowState = {
    width: 900,
    height: 670,
    isMaximized: false
  }
  const persistedState = settingsStore?.getWindowState() ?? fallback
  return intersectsVisibleDisplay(persistedState) ? persistedState : fallback
}

function buildWindowStateSnapshot(window: BrowserWindow): WindowState {
  const bounds = window.getBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized()
  }
}

function installWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | null = null

  const queueSave = (): void => {
    if (!settingsStore) {
      return
    }
    if (saveTimer) {
      clearTimeout(saveTimer)
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      void settingsStore?.saveWindowState(buildWindowStateSnapshot(window))
    }, 150)
  }

  window.on('move', queueSave)
  window.on('resize', queueSave)
  window.on('maximize', queueSave)
  window.on('unmaximize', queueSave)
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (settingsStore) {
      void settingsStore.saveWindowState(buildWindowStateSnapshot(window))
    }
  })
}

async function testSlskdConnection(input: unknown): Promise<SlskdConnectionTestResult> {
  const source =
    typeof input === 'object' && input !== null ? (input as Partial<SlskdConnectionTestInput>) : {}

  const baseURL = normalizeBaseURL(source.baseURL)
  const apiKey = normalizeApiKey(source.apiKey)

  if (!baseURL) {
    return {
      ok: false,
      status: null,
      endpoint: null,
      message: 'slskd Base URL is required.'
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      status: null,
      endpoint: null,
      message: 'slskd API key is required.'
    }
  }

  let parsedBaseURL: URL
  try {
    parsedBaseURL = new URL(baseURL)
  } catch {
    return {
      ok: false,
      status: null,
      endpoint: null,
      message: 'slskd Base URL is invalid.'
    }
  }

  if (!['http:', 'https:'].includes(parsedBaseURL.protocol)) {
    return {
      ok: false,
      status: null,
      endpoint: null,
      message: 'slskd Base URL must use http or https.'
    }
  }

  const resolvedBaseURL = parsedBaseURL.toString().replace(/\/+$/, '')
  const candidatePaths = ['/api/v0/application', '/api/v0/session', '/api/v0/options']
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey
  }

  let lastFailure: SlskdConnectionTestResult = {
    ok: false,
    status: null,
    endpoint: null,
    message: 'Unable to reach slskd API.'
  }

  for (const path of candidatePaths) {
    const endpoint = `${resolvedBaseURL}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, 6000)

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(timeout)

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          endpoint,
          message: `Connected to slskd (${response.status}).`
        }
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          endpoint,
          message: 'Authentication failed. Verify slskd API key.'
        }
      }

      lastFailure = {
        ok: false,
        status: response.status,
        endpoint,
        message: `slskd responded with ${response.status} ${response.statusText}.`
      }
    } catch (error) {
      clearTimeout(timeout)
      const isTimeout = error instanceof Error && error.name === 'AbortError'
      lastFailure = {
        ok: false,
        status: null,
        endpoint,
        message: isTimeout ? 'Connection timed out.' : formatError(error)
      }
    }
  }

  return lastFailure
}

function createWindow(): void {
  const windowState = resolveWindowState()

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(typeof windowState.x === 'number' && typeof windowState.y === 'number'
      ? { x: windowState.x, y: windowState.y }
      : {}),
    show: false,
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  if (windowState.isMaximized) {
    mainWindow.maximize()
  }

  installWindowStatePersistence(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  settingsStore = new SettingsStore(app.getPath('userData'))
  await settingsStore.init()
  const settingsSnapshot = settingsStore.snapshot()

  collectionService = new CollectionService({
    databaseFilePath: settingsSnapshot.appPaths.databaseFilePath,
    onUpdated: (status) => {
      mainWindow?.webContents.send('collection:updated', status)
    }
  })
  await collectionService.reconfigure(settingsSnapshot.settings)
  void collectionService.syncNow()

  ipcMain.handle('settings:get', async () => {
    if (!settingsStore) {
      throw new Error('Settings store not initialized')
    }
    return settingsStore.snapshot()
  })

  ipcMain.handle('settings:update', async (_event, patch) => {
    if (!settingsStore) {
      throw new Error('Settings store not initialized')
    }
    const snapshot = await settingsStore.update(patch)
    if (collectionService) {
      await collectionService.reconfigure(snapshot.settings)
      void collectionService.syncNow()
    }
    return snapshot
  })

  ipcMain.handle('settings:pick-directory', async (_event, options) => {
    const opt = typeof options === 'object' && options !== null ? options : {}
    const title =
      typeof (opt as { title?: unknown }).title === 'string'
        ? (opt as { title: string }).title
        : 'Select folder'
    const defaultPath =
      typeof (opt as { defaultPath?: unknown }).defaultPath === 'string'
        ? (opt as { defaultPath: string }).defaultPath
        : undefined

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title,
      defaultPath,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled) {
      return null
    }

    return result.filePaths[0] ?? null
  })

  ipcMain.handle('slskd:test-connection', async (_event, input) => {
    return testSlskdConnection(input)
  })

  ipcMain.handle('online-search:search', async (_event, query, scope) => {
    if (!settingsStore) {
      throw new Error('Settings store not initialized')
    }
    return onlineSearchService.search(settingsStore.snapshot().settings, query, scope)
  })

  ipcMain.handle('online-search:get-discogs-entity', async (_event, type, id) => {
    if (!settingsStore) {
      throw new Error('Settings store not initialized')
    }
    return onlineSearchService.getDiscogsEntity(settingsStore.snapshot().settings, type, id)
  })

  ipcMain.handle('grok-search:search', async (_event, query) => {
    if (!settingsStore) {
      throw new Error('Settings store not initialized')
    }
    return grokSearchService.search(settingsStore.snapshot().settings, query)
  })

  ipcMain.handle('collection:list', async (_event, query) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    const searchQuery = typeof query === 'string' ? query : ''
    return collectionService.list(searchQuery)
  })

  ipcMain.handle('collection:list-downloads', async (_event, query) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    const searchQuery = typeof query === 'string' ? query : ''
    return collectionService.listDownloads(searchQuery)
  })

  ipcMain.handle('collection:sync-now', async () => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    return collectionService.syncNow()
  })

  ipcMain.handle('collection:get-status', async () => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    return collectionService.getStatus()
  })

  ipcMain.handle('want-list:list', async () => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    return collectionService.wantListList()
  })

  ipcMain.handle('want-list:add', async (_event, input) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    const item = collectionService.wantListAdd(input)
    // Auto-search in background if slskd is configured
    void runSearchPipeline(item)
    return item
  })

  ipcMain.handle('want-list:update', async (_event, id, input) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    return collectionService.wantListUpdate(id, input)
  })

  ipcMain.handle('want-list:search', async (_event, id) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    const item = collectionService.wantListGet(id)
    if (!item) throw new Error('Want list item not found')
    const updated = collectionService.wantListUpdatePipeline(id, {
      pipelineStatus: 'idle',
      searchId: null,
      searchResultCount: 0,
      bestCandidatesJson: null,
      pipelineError: null
    })
    if (updated) emitWantListUpdated(updated)
    void runSearchPipeline(item)
    return updated
  })

  ipcMain.handle('want-list:get-candidates', async (_event, id) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    const item = collectionService.wantListGet(id)
    if (!item?.bestCandidatesJson) return []
    return JSON.parse(item.bestCandidatesJson)
  })

  ipcMain.handle('want-list:download', async (_event, id, username, filename, size) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    void runDownloadPipeline(id, username, filename, size)
  })

  ipcMain.handle('want-list:reset-pipeline', async (_event, id) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    return collectionService.wantListUpdatePipeline(id, {
      pipelineStatus: 'idle',
      searchId: null,
      searchResultCount: 0,
      bestCandidatesJson: null,
      downloadUsername: null,
      downloadFilename: null,
      pipelineError: null
    })
  })

  ipcMain.handle('want-list:remove', async (_event, id) => {
    if (!collectionService) {
      throw new Error('Collection service not initialized')
    }
    collectionService.wantListRemove(id)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  collectionService?.dispose()
  collectionService = null
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

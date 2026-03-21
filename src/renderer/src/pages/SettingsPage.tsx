import { useEffect, useMemo, useState } from 'react'
import Versions from '../components/Versions'
import { ActionButton, LabeledInput, Notice, ViewPanel, ViewSection } from '../components/view'

type AppSettings = {
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

type AppPaths = {
  userDataPath: string
  settingsFilePath: string
  dataDirPath: string
  databaseFilePath: string
  cacheDirPath: string
  logsDirPath: string
}

const EMPTY_SETTINGS: AppSettings = {
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

type SlskdConnectionTestResult = {
  ok: boolean
  status: number | null
  endpoint: string | null
  message: string
}

const EMPTY_PATHS: AppPaths = {
  userDataPath: '',
  settingsFilePath: '',
  dataDirPath: '',
  databaseFilePath: '',
  cacheDirPath: '',
  logsDirPath: ''
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected settings error'
}

function LabeledTextInput({
  label,
  value,
  placeholder,
  type = 'text',
  autoComplete,
  onChange,
  onBlur,
  onPick
}: {
  label: string
  value: string
  placeholder?: string
  type?: 'text' | 'password'
  autoComplete?: string
  onChange: (value: string) => void
  onBlur?: () => void
  onPick?: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <LabeledInput
          label={label}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className="block flex-1"
          inputClassName="h-9 rounded-md border-zinc-800 bg-zinc-950/30"
        />
        {onPick ? (
          <div className="pt-[18px]">
            <ActionButton type="button" onClick={onPick}>
              Browse
            </ActionButton>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SettingsSection({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ViewSection title={title} subtitle={subtitle} className="p-4">
      {children}
    </ViewSection>
  )
}

export default function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS)
  const [appPaths, setAppPaths] = useState<AppPaths>(EMPTY_PATHS)
  const [newDownloadPath, setNewDownloadPath] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTestingSlskd, setIsTestingSlskd] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [slskdTestResult, setSlskdTestResult] = useState<SlskdConnectionTestResult | null>(null)

  const hasAnySyncPath = useMemo(() => {
    return Boolean(
      settings.musicFolderPath || settings.songsFolderPath || settings.downloadFolderPaths.length
    )
  }, [settings.downloadFolderPaths.length, settings.musicFolderPath, settings.songsFolderPath])

  const songsFolderPickerDefault = useMemo(() => {
    const musicRoot = settings.musicFolderPath.replace(/\/+$/, '')
    const songsRelative = settings.songsFolderPath.replace(/^\/+/, '')
    if (!musicRoot) {
      return settings.songsFolderPath
    }
    if (!songsRelative) {
      return musicRoot
    }
    return `${musicRoot}/${songsRelative}`
  }, [settings.musicFolderPath, settings.songsFolderPath])

  const serperDocsURL = 'https://serper.dev/'
  const discogsDocsURL = 'https://www.discogs.com/settings/developers'
  const grokDocsURL = 'https://docs.x.ai'
  const youtubeDocsURL = 'https://developers.google.com/youtube/v3/getting-started'

  const setSnapshot = (snapshot: { settings: AppSettings; appPaths: AppPaths }): void => {
    setSettings(snapshot.settings)
    setAppPaths(snapshot.appPaths)
  }

  useEffect(() => {
    const loadSettings = async (): Promise<void> => {
      setIsLoading(true)
      setErrorMessage(null)
      try {
        const snapshot = await window.api.settings.get()
        setSnapshot(snapshot)
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setIsLoading(false)
      }
    }

    void loadSettings()
  }, [])

  const updateSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    setIsSaving(true)
    setErrorMessage(null)
    try {
      const snapshot = await window.api.settings.update(patch)
      setSnapshot(snapshot)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setIsSaving(false)
    }
  }

  const pickDirectory = async (title: string, defaultPath: string): Promise<string | null> => {
    try {
      return await window.api.settings.pickDirectory({
        title,
        defaultPath: defaultPath.trim() || undefined
      })
    } catch (error) {
      setErrorMessage(formatError(error))
      return null
    }
  }

  const testSlskdConnection = async (): Promise<void> => {
    setIsTestingSlskd(true)
    setErrorMessage(null)
    try {
      const result = await window.api.slskd.testConnection({
        baseURL: settings.slskdBaseURL,
        apiKey: settings.slskdApiKey
      })
      setSlskdTestResult(result)
    } catch (error) {
      setSlskdTestResult({
        ok: false,
        status: null,
        endpoint: null,
        message: formatError(error)
      })
    } finally {
      setIsTestingSlskd(false)
    }
  }

  if (isLoading) {
    return (
      <Notice className="p-4 text-sm text-zinc-300">
        Loading settings…
      </Notice>
    )
  }

  return (
    <div className="space-y-4">
      <SettingsSection title="Library Paths" subtitle="Local folders used by DJBrain (no Dropbox).">
        <div className="mt-4 space-y-3">
          <LabeledTextInput
            label="Music Root Folder"
            value={settings.musicFolderPath}
            placeholder="/Users/you/Music"
            onChange={(value) => setSettings((prev) => ({ ...prev, musicFolderPath: value }))}
            onBlur={() => void updateSettings({ musicFolderPath: settings.musicFolderPath })}
            onPick={async () => {
              const folder = await pickDirectory(
                'Select music root folder',
                settings.musicFolderPath
              )
              if (!folder) return
              setSettings((prev) => ({ ...prev, musicFolderPath: folder }))
              void updateSettings({ musicFolderPath: folder })
            }}
          />

          <LabeledTextInput
            label="Songs Folder (Relative to Music Root)"
            value={settings.songsFolderPath}
            placeholder="songs"
            onChange={(value) => setSettings((prev) => ({ ...prev, songsFolderPath: value }))}
            onBlur={() => void updateSettings({ songsFolderPath: settings.songsFolderPath })}
            onPick={async () => {
              const folder = await pickDirectory('Select songs folder', songsFolderPickerDefault)
              if (!folder) return
              setSettings((prev) => ({ ...prev, songsFolderPath: folder }))
              void updateSettings({ songsFolderPath: folder })
            }}
          />

          <div className="pt-2">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
              Download Folders
            </div>
            <div className="mt-1 text-sm text-zinc-400">
              Paths relative to Music Root Folder (for import/watch workflows).
            </div>
          </div>

          <div className="space-y-2">
            {settings.downloadFolderPaths.map((pathValue, index) => (
              <div key={`${pathValue}-${index}`} className="flex gap-2">
                <input
                  value={pathValue}
                  onChange={(event) => {
                    const next = [...settings.downloadFolderPaths]
                    next[index] = event.target.value
                    setSettings((prev) => ({ ...prev, downloadFolderPaths: next }))
                  }}
                  onBlur={() =>
                    void updateSettings({ downloadFolderPaths: settings.downloadFolderPaths })
                  }
                  className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950/30 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-700"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = settings.downloadFolderPaths.filter(
                      (_, itemIndex) => itemIndex !== index
                    )
                    setSettings((prev) => ({ ...prev, downloadFolderPaths: next }))
                    void updateSettings({ downloadFolderPaths: next })
                  }}
                  className="inline-flex h-9 shrink-0 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
                >
                  Remove
                </button>
              </div>
            ))}

            <div className="flex gap-2">
              <input
                value={newDownloadPath}
                onChange={(event) => setNewDownloadPath(event.target.value)}
                placeholder="downloads/incoming"
                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950/30 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-700"
              />
              <button
                type="button"
                onClick={() => {
                  const candidate = newDownloadPath.trim()
                  if (!candidate) return
                  const next = Array.from(new Set([...settings.downloadFolderPaths, candidate]))
                  setSettings((prev) => ({ ...prev, downloadFolderPaths: next }))
                  setNewDownloadPath('')
                  void updateSettings({ downloadFolderPaths: next })
                }}
                className="inline-flex h-9 shrink-0 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
              >
                Add
              </button>
              <button
                type="button"
                onClick={async () => {
                  const folder = await pickDirectory(
                    'Select download folder',
                    settings.musicFolderPath
                  )
                  if (!folder) return
                  const next = Array.from(new Set([...settings.downloadFolderPaths, folder]))
                  setSettings((prev) => ({ ...prev, downloadFolderPaths: next }))
                  void updateSettings({ downloadFolderPaths: next })
                }}
                className="inline-flex h-9 shrink-0 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
              >
                Browse
              </button>
            </div>

            <div className="text-xs text-zinc-500">
              Absolute paths picked with Browse are converted to relative if they are inside Music
              Root.
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Soulseek (slskd)" subtitle="Connection settings for your `slskd` server.">
        <div className="mt-4">
          <LabeledTextInput
            label="slskd Base URL"
            value={settings.slskdBaseURL}
            placeholder="http://localhost:5030"
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, slskdBaseURL: value }))
              setSlskdTestResult(null)
            }}
            onBlur={() => void updateSettings({ slskdBaseURL: settings.slskdBaseURL })}
          />
          <div className="mt-3">
            <LabeledTextInput
              label="slskd API Key"
              type="password"
              autoComplete="off"
              value={settings.slskdApiKey}
              placeholder="your-api-key"
              onChange={(value) => {
                setSettings((prev) => ({ ...prev, slskdApiKey: value }))
                setSlskdTestResult(null)
              }}
              onBlur={() => void updateSettings({ slskdApiKey: settings.slskdApiKey })}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <ActionButton
              type="button"
              onClick={() => {
                void testSlskdConnection()
              }}
              disabled={isTestingSlskd}
            >
              {isTestingSlskd ? 'Testing…' : 'Test Connection'}
            </ActionButton>
            {slskdTestResult ? (
              <div
                className={`text-xs ${slskdTestResult.ok ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {slskdTestResult.message}
                {slskdTestResult.endpoint ? ` (${slskdTestResult.endpoint})` : ''}
              </div>
            ) : (
              <div className="text-xs text-zinc-500">
                Verifies URL + API key against the slskd HTTP API.
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Discogs" subtitle="User token for direct Discogs API search.">
        <div className="mt-4 space-y-3">
          <LabeledTextInput
            label="Discogs User Token"
            type="password"
            autoComplete="off"
            value={settings.discogsUserToken}
            placeholder="your-discogs-user-token"
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, discogsUserToken: value }))
            }}
            onBlur={() => void updateSettings({ discogsUserToken: settings.discogsUserToken })}
          />

          <div className="text-xs text-zinc-500">
            DJBrain uses the Discogs API directly for Discogs searches instead of routing them
            through Serper.
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={discogsDocsURL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
            >
              Open Discogs
            </a>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Serper" subtitle="API key for Serper web search.">
        <div className="mt-4 space-y-3">
          <LabeledTextInput
            label="Serper API Key"
            type="password"
            autoComplete="off"
            value={settings.serperApiKey}
            placeholder="your-serper-api-key"
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, serperApiKey: value }))
            }}
            onBlur={() => void updateSettings({ serperApiKey: settings.serperApiKey })}
          />

          <div className="text-xs text-zinc-500">
            DJBrain uses Serper only for the broader online search across indexed sources.
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={serperDocsURL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
            >
              Open Serper
            </a>
          </div>

          <div className="text-xs text-zinc-500">
            Generate the API key in Serper and paste it here. No project ID, location, or engine ID
            is needed.
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="YouTube Data API"
        subtitle="Official YouTube Data API v3 key for direct YouTube search."
      >
        <div className="mt-4 space-y-3">
          <LabeledTextInput
            label="YouTube API Key"
            type="password"
            autoComplete="off"
            value={settings.youtubeApiKey}
            placeholder="your-youtube-api-key"
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, youtubeApiKey: value }))
            }}
            onBlur={() => void updateSettings({ youtubeApiKey: settings.youtubeApiKey })}
          />

          <div className="text-xs text-zinc-500">
            Enable YouTube Data API v3 in a Google Cloud project, create an API key, and paste it
            here. This is set up as a separate API path and is not wired into the current search UI
            yet.
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={youtubeDocsURL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
            >
              Open YouTube Docs
            </a>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Grok (xAI)" subtitle="API key for Grok-powered online music search.">
        <div className="mt-4 space-y-3">
          <LabeledTextInput
            label="Grok API Key"
            type="password"
            autoComplete="off"
            value={settings.grokApiKey}
            placeholder="xai-..."
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, grokApiKey: value }))
            }}
            onBlur={() => void updateSettings({ grokApiKey: settings.grokApiKey })}
          />

          <div className="text-xs text-zinc-500">
            Used by the Grok Search page to return structured track rows (artist, title, version,
            year).
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={grokDocsURL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
            >
              Open xAI Docs
            </a>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Local Storage Paths" subtitle="Managed in app support. SQLite + cache + logs stay local.">
        <div className="mt-4 space-y-2 text-xs text-zinc-300">
          <ViewPanel tone="muted" padding="sm" className="rounded-md px-3 py-2">
            <div className="text-zinc-400">User data</div>
            <div className="mt-1 break-all font-mono">{appPaths.userDataPath || '—'}</div>
          </ViewPanel>
          <ViewPanel tone="muted" padding="sm" className="rounded-md px-3 py-2">
            <div className="text-zinc-400">Settings file</div>
            <div className="mt-1 break-all font-mono">{appPaths.settingsFilePath || '—'}</div>
          </ViewPanel>
          <ViewPanel tone="muted" padding="sm" className="rounded-md px-3 py-2">
            <div className="text-zinc-400">SQLite database</div>
            <div className="mt-1 break-all font-mono">{appPaths.databaseFilePath || '—'}</div>
          </ViewPanel>
          <ViewPanel tone="muted" padding="sm" className="rounded-md px-3 py-2">
            <div className="text-zinc-400">Cache directory</div>
            <div className="mt-1 break-all font-mono">{appPaths.cacheDirPath || '—'}</div>
          </ViewPanel>
          <ViewPanel tone="muted" padding="sm" className="rounded-md px-3 py-2">
            <div className="text-zinc-400">Logs directory</div>
            <div className="mt-1 break-all font-mono">{appPaths.logsDirPath || '—'}</div>
          </ViewPanel>
        </div>

        <div className="mt-3 text-xs text-zinc-500">
          {hasAnySyncPath
            ? 'At least one library path is configured.'
            : 'No library paths configured yet. Choose folders above.'}
        </div>
      </SettingsSection>

      {errorMessage ? <Notice tone="error" className="text-sm">{errorMessage}</Notice> : null}
      {isSaving ? <div className="text-xs text-zinc-400">Saving settings…</div> : null}

      <SettingsSection title="About" subtitle="Version and runtime info.">
        <div className="mt-3">
          <Versions />
        </div>
      </SettingsSection>
    </div>
  )
}

# DJBrain 2026

A desktop app for DJ music management: discover, collect, download, tag, and organise your music library.

---

## Table of Contents

1. [Vision](#vision)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Project Structure](#project-structure)
5. [IPC Bridge Pattern](#ipc-bridge-pattern)
6. [Database Schema](#database-schema)
7. [Settings](#settings)
8. [Navigation & Routing](#navigation--routing)
9. [Services](#services)
10. [Want List & Pipeline](#want-list--pipeline)
11. [Scoring Algorithm](#scoring-algorithm)
12. [Shared Utilities](#shared-utilities)
13. [Styling Guidelines](#styling-guidelines)
14. [How to Add a New Feature](#how-to-add-a-new-feature)
15. [Testing](#testing)
16. [Content Security Policy](#content-security-policy)
17. [Roadmap](#roadmap)

---

## Vision

DJBrain automates the full lifecycle of a DJ track:

```
Discover → Want List → Search (Soulseek) → Download → Auto-tag → Import to Collection
```

Every step allows manual intervention. You can inspect results, pick the best file, correct metadata, and trigger or skip any step.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 39 |
| Frontend | React 19 + TypeScript |
| Routing | React Router v7 (HashRouter) |
| Styling | Tailwind CSS 3 (dark zinc palette) |
| Icons | Radix UI Icons |
| UI primitives | Radix UI (Switch, Separator, Dropdown) |
| Build | electron-vite + Vite 7 |
| Database | SQLite via Node.js built-in `node:sqlite` (`DatabaseSync`) |
| Music search | slskd REST API (Soulseek daemon) |
| Metadata | Discogs API, Serper (Google), Grok AI (xAI) |
| Testing | Node.js built-in `node:test` + `node:assert/strict` |
| Packaging | electron-builder |

Node.js 24+, npm 11+.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Renderer Process (React)                                   │
│  src/renderer/src/                                          │
│  Pages → window.api.* calls                                │
└──────────────────────┬─────────────────────────────────────┘
                       │ contextBridge (window.api)
┌──────────────────────▼─────────────────────────────────────┐
│  Preload Script                                             │
│  src/preload/index.ts                                       │
│  ipcRenderer.invoke / ipcRenderer.on                       │
└──────────────────────┬─────────────────────────────────────┘
                       │ ipcMain.handle / webContents.send
┌──────────────────────▼─────────────────────────────────────┐
│  Main Process (Node.js)                                     │
│  src/main/index.ts  – IPC handler registry                 │
│  src/main/*-service.ts  – Business logic                   │
│  node:sqlite  – SQLite (synchronous API)                   │
└────────────────────────────────────────────────────────────┘
```

**Rules:**
- The renderer **never** accesses Node.js APIs directly — only via `window.api`.
- All `window.api` types live in `src/preload/index.ts` (both implementation and types).
- Heavy I/O and database work happens in main-process services.
- Push updates (pipeline progress, collection sync) go via `webContents.send()` and are subscribed to with `ipcRenderer.on()`.

---

## Project Structure

```
src/
├── main/
│   ├── index.ts                 # App init + all IPC handler registrations
│   ├── collection-service.ts    # SQLite DB, file scanning, FTS, want list CRUD
│   ├── slskd-service.ts         # Soulseek search & download via slskd REST API
│   ├── online-search-service.ts # Discogs + Serper search, entity detail fetching
│   ├── grok-search-service.ts   # Grok AI LLM music search
│   └── settings-store.ts        # settings.json + window-state.json persistence
├── preload/
│   └── index.ts                 # contextBridge: exposes window.api, all types
├── renderer/
│   ├── index.html               # Entry HTML (CSP meta tag lives here)
│   └── src/
│       ├── App.tsx              # RouterProvider + all routes
│       ├── app/nav.ts           # NAV_ITEMS constant (sidebar entries)
│       ├── layout/AppShell.tsx  # Sidebar + TopBar + NowPlayingBar wrapper
│       ├── components/          # Sidebar, TopBar, NowPlayingBar
│       ├── pages/               # One file per route (see routing table)
│       └── styles/globals.css   # Tailwind base styles
└── shared/
    ├── discogs.ts               # Discogs type definitions
    ├── grok-search.ts           # Grok result types
    ├── online-search.ts         # OnlineSearch result types
    ├── track-title-parser.ts    # Parses "Title (Version)" strings
    └── track-title-parser.test.ts
```

---

## IPC Bridge Pattern

### Adding a new IPC call

**1. Main process — register handler** (`src/main/index.ts`):
```typescript
ipcMain.handle('my-feature:do-thing', async (_event, arg: string) => {
  return myService.doThing(arg)
})
```

**2. Preload — expose via contextBridge** (`src/preload/index.ts`):

Add to the `api` object inside `contextBridge.exposeInMainWorld`:
```typescript
myFeature: {
  doThing: (arg: string): Promise<MyResult> =>
    ipcRenderer.invoke('my-feature:do-thing', arg),
},
```

Also add the TypeScript type to the `DJBrainApi` interface in the same file.

**3. Renderer — call it**:
```typescript
const result = await window.api.myFeature.doThing('hello')
```

### Push events (main → renderer)

**Main** (emit):
```typescript
mainWindow.webContents.send('my-feature:updated', payload)
```

**Preload** (subscribe):
```typescript
onUpdated: (listener: (payload: MyPayload) => void): (() => void) => {
  const handler = (_: unknown, p: MyPayload) => listener(p)
  ipcRenderer.on('my-feature:updated', handler)
  return () => ipcRenderer.removeListener('my-feature:updated', handler)
},
```

**Renderer** (React hook pattern):
```typescript
useEffect(() => {
  return window.api.myFeature.onUpdated((payload) => {
    setState(payload)
  })
}, [])
```

The returned cleanup function is called when the component unmounts. Always return it from `useEffect`.

---

## Database Schema

Single SQLite file at `{userData}/data/djbrain.sqlite`. WAL mode, `synchronous = NORMAL`.

### `collection_files`
```sql
filename TEXT PRIMARY KEY    -- absolute path to the audio file
filesize INTEGER NOT NULL
```

### `collection_file_state`
```sql
filename TEXT PRIMARY KEY
mtime_ms INTEGER NOT NULL    -- last known modification time
```

### `collection_files_fts` (FTS5 virtual table)
Full-text search on `filename`. Maintained automatically by triggers on `collection_files`.

### `want_list`
```sql
id               INTEGER PRIMARY KEY AUTOINCREMENT
artist           TEXT NOT NULL
title            TEXT NOT NULL
version          TEXT                        -- e.g. "Extended Version"
length           TEXT                        -- track duration string
album            TEXT
label            TEXT
added_at         TEXT NOT NULL DEFAULT (datetime('now'))

-- Pipeline fields (added by idempotent migration):
pipeline_status  TEXT NOT NULL DEFAULT 'idle'
search_id        TEXT                        -- slskd search UUID
search_result_count INTEGER NOT NULL DEFAULT 0
best_candidates_json TEXT                   -- JSON array of SlskdCandidate
download_username TEXT
download_filename TEXT
pipeline_error   TEXT
```

### Migrations

There is no migration system. New columns are added with an **idempotent guard**:
```typescript
const existing = db.prepare('PRAGMA table_info(want_list)').all() as { name: string }[]
const cols = new Set(existing.map((r) => r.name))
if (!cols.has('my_new_column')) {
  db.exec('ALTER TABLE want_list ADD COLUMN my_new_column TEXT')
}
```

Always use this pattern — never use `IF NOT EXISTS` (not supported for columns in SQLite).

---

## Settings

Persisted to `{userData}/settings.json`.

```typescript
interface AppSettings {
  // Filesystem
  musicFolderPath: string          // Absolute path to music library root
  songsFolderPath: string          // Relative to musicFolderPath (e.g. "Songs")
  downloadFolderPaths: string[]    // Relative paths scanned as "downloads"

  // slskd / Soulseek
  slskdBaseURL: string             // Default: http://localhost:5030
  slskdApiKey: string

  // External APIs
  discogsUserToken: string
  grokApiKey: string
  serperApiKey: string
}
```

`SettingsStore` in `src/main/settings-store.ts` handles reads, writes, path derivation, and window-state (`{userData}/window-state.json`).

---

## Navigation & Routing

`src/renderer/src/app/nav.ts` defines `NAV_ITEMS`. Each entry has:
```typescript
{ key: string; label: string; path: string; icon: React.ComponentType }
```

`src/renderer/src/App.tsx` maps paths to page components using `<Route>`.

To add a new page:
1. Create `src/renderer/src/pages/MyPage.tsx`
2. Add a nav item in `nav.ts`
3. Add `<Route path="/my-page" element={<MyPage />} />` in `App.tsx`

### Routing table

| Path | Page | Status |
|------|------|--------|
| `/collection` | CollectionPage | Working |
| `/wantlist` | WantlistPage | Working |
| `/search-online` | SearchOnlinePage | Working |
| `/grok-search` | GrokSearchPage | Working |
| `/discogs/release/:id` | DiscogsEntityPage | Working |
| `/discogs/artist/:id` | DiscogsEntityPage | Working |
| `/discogs/label/:id` | DiscogsEntityPage | Working |
| `/discogs/master/:id` | DiscogsEntityPage | Working |
| `/soulseek` | SoulseekPage | Stub |
| `/spotify` | SpotifyPage | Stub |
| `/import` | ImportPage | Stub |
| `/dropbox` | DropboxPage | Stub |
| `/settings` | SettingsPage | Working |

---

## Services

### CollectionService (`src/main/collection-service.ts`)

Manages the SQLite database, file scanning, FTS search, and want list CRUD.

- `scan()` — walks music folder and download folders, updates DB incrementally
- `list(query)` — FTS search ranked by BM25
- `listDownloads(query)` — filters to download folder paths only
- `wantListAdd/Update/Remove/List/Get`
- `wantListUpdatePipeline(id, patch)` — partial update of pipeline fields only

Supported audio extensions: `.mp3 .flac .wav .aiff .aif .m4a .aac .ogg .opus .alac`

### SlskdService (`src/main/slskd-service.ts`)

Wraps the slskd REST API.

- `buildSearchQuery(artist, title, version)` — builds `"artist title version"` string
- `startSearch(settings, query)` — `POST /api/v0/searches` → returns `searchId`
- `waitForResults(settings, searchId, timeoutMs=60000)` — polls every 2.5s until state ≠ `InProgress`
- `extractCandidates(artist, title, version, search)` — scores files, returns top 30
- `downloadFile(settings, username, filename, size)` — `POST /api/v0/transfers/downloads/{username}`
- `waitForDownload(settings, username, filename, timeoutMs=600000)` — polls every 5s

Searches are **intentionally not deleted** so you can inspect them in slskd's web UI.

### OnlineSearchService (`src/main/online-search-service.ts`)

- Discogs search (`GET /database/search`) + entity detail (`GET /releases/{id}` etc.)
- Serper.dev Google search
- Parses release/master/artist/label pages into a uniform `DiscogsEntityDetail` structure
- Extracts: tracklist, videos (YouTube links only), facts, related sections, hero image

### GrokSearchService (`src/main/grok-search-service.ts`)

Uses Grok AI with web search tools to find tracks. Returns structured `GrokTrackResult[]`.

### SettingsStore (`src/main/settings-store.ts`)

- Reads/writes `settings.json` and `window-state.json`
- Exposes `snapshot()` and `update(patch)` — patch is merged, not replaced
- Saves/restores window size and position; validates the window is on-screen

---

## Want List & Pipeline

Each want list item has a `pipelineStatus` field:

```
idle → searching → results_ready → downloading → downloaded
                 ↘ no_results
            (any) → error
```

### Lifecycle

| Status | Meaning |
|--------|---------|
| `idle` | Waiting; user can trigger search manually |
| `searching` | Search submitted to slskd; polling in progress |
| `results_ready` | Candidates scored and stored in `bestCandidatesJson` |
| `no_results` | Search completed but nothing matched |
| `downloading` | Download in flight; polling slskd transfers |
| `downloaded` | File is on disk |
| `error` | Something failed; `pipelineError` has the message |

Adding to the want list **auto-triggers** the search pipeline if slskd is configured.

The UI subscribes to `window.api.wantList.onItemUpdated()` for real-time updates pushed from the main process.

### Manual actions in UI

- **Search / Re-search** — triggers search pipeline
- **↺ Reset** — clears all pipeline state back to `idle`
- **Expand row** — loads and shows scored candidates
- **Download** (per candidate) — triggers download pipeline
- **Edit** — inline edit of artist/title/version/album/label/length
- **× Remove** — deletes from want list

---

## Scoring Algorithm

Files are scored 0–100+ by `SlskdService.scoreFile()`:

| Signal | Points |
|--------|--------|
| Artist + title in filename | +50 |
| Title only in filename | +25 |
| Version in filename | +15 |
| FLAC or WAV format | +25 |
| MP3 format | +10 |
| Bitrate ≥ 320 kbps | +5 |
| Reasonable file size (5 MB–150 MB) | +5 |

Top 30 candidates (by score descending) are stored as JSON. Score ≥ 60 shown in green, ≥ 30 in amber, below in red.

---

## Shared Utilities

### `src/shared/track-title-parser.ts`

Splits a raw track title into `{ title, version }`:

```typescript
parseTrackTitle('Protec (Extended Version)')
// → { title: 'Protec', version: 'Extended Version' }

parseTrackTitle('Legend [Radio Edit]')
// → { title: 'Legend', version: 'Radio Edit' }

parseTrackTitle('Simple Title')
// → { title: 'Simple Title', version: null }
```

Rule: the **last** parenthetical or bracketed group at the end of the string is treated as the version. If the group is empty or the title before it is empty, no split is made.

Used in `DiscogsEntityPage` before adding a track to the want list.

---

## Styling Guidelines

- **Dark theme only** — Tailwind `zinc` palette, no light mode
- **Background layers**: `zinc-900` (app bg) → `zinc-800` (cards/panels) → `zinc-700` (inputs/hover)
- **Text**: `zinc-100` (primary), `zinc-400` (secondary/muted)
- **Accent / interactive**: `indigo-500` (active nav, primary buttons), `indigo-400` (hover)
- **Status colours**:
  - Green: `green-400` / `green-500` — success, high score (≥60), downloaded
  - Amber: `amber-400` — warning, medium score (≥30), downloading
  - Red: `red-400` — error, low score (<30)
  - Blue: `blue-400` — searching, in-progress states
- **Pulsing dot** (`animate-pulse`) on active pipeline states (searching, downloading)
- **Buttons**: `px-3 py-1.5 rounded text-sm` base; colour variant classes on top
- **No inline styles** — use Tailwind classes only
- **Icon size**: `w-4 h-4` (small), `w-5 h-5` (normal), consistent with Radix UI icons

---

## How to Add a New Feature

### New page with data from main process

1. Define the data type in `src/preload/index.ts` (add to `DJBrainApi` interface)
2. Add the service method in the appropriate `src/main/*-service.ts`
3. Register an IPC handler in `src/main/index.ts`
4. Expose it in the preload bridge
5. Create the page in `src/renderer/src/pages/`
6. Add nav item in `nav.ts` + route in `App.tsx`

### New SQLite column

Use the idempotent migration pattern (see [Migrations](#migrations) above). Place it in the service constructor.

### New real-time push event

See [Push events](#push-events-main--renderer) above. Main emits with `webContents.send`, preload subscribes with `ipcRenderer.on`, renderer uses `useEffect` returning the unsubscribe function.

### New external API integration

- Add API key to `AppSettings` in `settings-store.ts` and to `SettingsPage`
- Create `src/main/my-api-service.ts`
- Instantiate in `src/main/index.ts`
- Register IPC handler
- Expose in preload

---

## Testing

Tests use the Node.js built-in test runner. No Jest, no Vitest.

```bash
npm test
# runs: node --experimental-strip-types --test 'src/shared/*.test.ts'
```

Test file conventions:
- Co-located next to the file under test: `foo.ts` → `foo.test.ts`
- Currently only `src/shared/` is tested (main-process services depend on Electron APIs)
- Import the `.ts` extension explicitly — required by `--experimental-strip-types`:
  ```typescript
  import { myFn } from './my-module.ts'   // required
  ```
- Use `node:test` and `node:assert/strict`:
  ```typescript
  import { describe, it } from 'node:test'
  import assert from 'node:assert/strict'

  describe('myFn', () => {
    it('does the thing', () => {
      assert.deepEqual(myFn('input'), { expected: 'output' })
    })
  })
  ```

---

## Content Security Policy

Defined in `src/renderer/index.html` as a `<meta http-equiv="Content-Security-Policy">` tag.

Current policy allows:
- `img-src 'self' data: https:` — Discogs images and all HTTPS images
- `frame-src https://www.youtube.com` — YouTube embed iframes
- `connect-src 'self' https:` — all HTTPS API calls from renderer (Discogs, Serper, etc.)

When embedding a new external source, add it to the appropriate CSP directive. Do not add `unsafe-eval` or `unsafe-inline` for scripts.

---

## Roadmap

Planned but not yet implemented:

| Feature | Notes |
|---------|-------|
| **Auto-tag** | After download: write ID3/FLAC tags (artist, title, album, label) from want list metadata. Terminal state is currently `downloaded`. |
| **Auto-import** | Move file from slskd download directory to `songsFolderPath`; trigger collection rescan. |
| **Soulseek page** | Dedicated UI for browsing slskd searches, transfers, and user shares |
| **Spotify integration** | Import liked tracks or playlists as want list items |
| **Dropbox sync** | Sync collection to/from Dropbox |
| **Import workflow** | Batch import with metadata review and duplicate detection |
| **Now Playing bar** | Wire up audio playback (bar exists in layout shell, not yet functional) |
| **Beatport / Apple Music** | Extend online search candidates |

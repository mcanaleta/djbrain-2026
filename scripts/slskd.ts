/**
 * slskd integration script
 *
 * Modes:
 *   1. Search + download + import a single song (default: Crispy Bacon demo)
 *   2. Scan hasoulseek/complete and auto-import any audio files found there
 */

import { SlskdService } from '../src/backend/slskd-service.ts'
import { DiscogsMatchService } from '../src/backend/discogs-match-service.ts'
import { TaggerService } from '../src/backend/tagger-service.ts'
import { ImportService, parseSongFilename, type ImportResult } from '../src/backend/import-service.ts'
import { OnlineSearchService } from '../src/backend/online-search-service.ts'
import { readSettings } from '../src/backend/settings-store.ts'
import { readdir } from 'node:fs/promises'
import { join, extname, basename, resolve } from 'node:path'

const AUDIO_EXTS = new Set(['.mp3', '.aif', '.aiff', '.flac', '.wav', '.aac', '.m4a', '.ogg'])

async function loadSettings() {
  return readSettings()
}

function printImportResult(result: ImportResult) {
  if (result.status === 'imported') {
    console.log('\n  ✓ IMPORTED')
    console.log('    dest:', result.destRelativePath)
    console.log('    discogs:', result.match.releaseId, '—', result.match.releaseTitle)
    console.log('    artist:', result.match.artist, '/ title:', result.match.title)
    console.log('    pos:', result.match.trackPosition, '/ year:', result.match.year)
    console.log('    label:', result.match.label, '/ catalog:', result.match.catalogNumber)
  } else if (result.status === 'imported_upgrade') {
    console.log('\n  ↑ IMPORTED AS UPGRADE (better quality)')
    console.log('    new (higher quality):', result.destRelativePath)
    console.log('    existing kept:', result.existingRelativePath)
    console.log('    discogs:', result.match.releaseId, '—', result.match.releaseTitle)
    console.log('    artist:', result.match.artist, '/ title:', result.match.title)
  } else if (result.status === 'skipped_existing') {
    console.log('\n  ─ SKIPPED (existing file is as good or better)')
    console.log('    existing:', result.existingRelativePath)
    console.log(
      '    quality: existing is better/equal —',
      `new=${result.newQuality.formatClass} ${(result.newQuality.fileSizeBytes / 1e6).toFixed(1)}MB,`,
      `existing=${result.existingQuality.formatClass} ${(result.existingQuality.fileSizeBytes / 1e6).toFixed(1)}MB`
    )
  } else if (result.status === 'needs_review') {
    console.log('\n  ? NEEDS REVIEW — no confident Discogs match')
    for (const c of result.candidates.slice(0, 3)) {
      console.log(
        `    score=${c.score} release=${c.releaseId} "${c.releaseTitle}" track="${c.title}" year=${c.year}`
      )
    }
  } else {
    console.log('\n  ✗ ERROR:', result.message)
  }
}

// ─── Search + download + import ───────────────────────────────────────────────

async function searchDownloadImport(
  svc: SlskdService,
  importService: ImportService,
  settings: unknown,
  artist: string,
  title: string,
  version: string | null
) {
  console.log(`\n══ ${artist} - ${title}${version ? ` (${version})` : ''} ══`)

  // 1. Search
  const query = svc.buildSearchQuery(artist, title, version)
  console.log('[1] Starting search:', JSON.stringify(query))
  const searchId = await svc.startSearch(settings, query)

  // 2. Wait for results
  console.log('[2] Waiting for results (up to 60s)...')
  const result = await svc.waitForResults(settings, searchId, 60_000)
  console.log(`    state: ${result.state}, responses: ${result.responses?.length ?? 0}`)

  // 3. Pick best
  const candidates = svc.extractCandidates(artist, title, version, result)
  console.log('[3] Top 3 candidates:')
  for (const c of candidates.slice(0, 3)) {
    console.log(
      `    score=${c.score} ${c.extension} ${c.bitrate ?? '?'}kbps ${(c.size / 1e6).toFixed(1)}MB ${c.username}`
    )
  }

  const best = candidates[0]
  if (!best) {
    console.error('    No candidates found — aborting.')
    await svc.deleteSearch(settings, searchId).catch(() => {})
    return
  }

  // 4. Download (skip if already done)
  const existingState = await svc.getDownloadState(settings, best.username, best.filename)
  if (!existingState?.startsWith('Completed')) {
    console.log(`[4] Downloading from ${best.username} (${(best.size / 1e6).toFixed(1)}MB)...`)
    await svc.downloadFile(settings, best.username, best.filename, best.size)

    console.log('[5] Polling download (up to 10 min)...')
    let dots = 0
    const deadline = Date.now() + 600_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000))
      const state = await svc.getDownloadState(settings, best.username, best.filename)
      process.stdout.write(`\r    state=${state ?? 'unknown'} ${'.'.repeat(++dots % 4).padEnd(3)}`)
      if (state?.startsWith('Completed')) {
        console.log('\n    DOWNLOAD COMPLETE!')
        break
      }
      if (
        state === null ||
        state?.startsWith('Cancelled') ||
        state?.startsWith('TimedOut') ||
        state?.startsWith('Errored') ||
        state?.startsWith('Rejected')
      ) {
        console.log(`\n    Download failed: ${state}`)
        await svc.deleteSearch(settings, searchId).catch(() => {})
        return
      }
    }
  } else {
    console.log('[4] Already downloaded, skipping.')
  }

  await svc.deleteSearch(settings, searchId).catch(() => {})

  // 6. Resolve local path (include hasoulseek/complete for HA-synced files)
  const settingsWithHa = {
    ...settings,
    downloadFolderPaths: [...settings.downloadFolderPaths, 'hasoulseek/complete']
  }
  console.log('[6] Resolving local file path...')
  const localPath = await importService.resolveLocalPath(settingsWithHa, best.filename)
  if (!localPath) {
    console.error('    Could not find local file — Dropbox may still be syncing.')
    return
  }
  console.log('    found:', localPath)

  // 7. Import
  console.log('[7] Importing...')
  const importResult = await importService.importFile(
    settings,
    artist,
    title,
    version,
    localPath,
    best.bitrate ?? null
  )
  printImportResult(importResult)
}

// ─── Scan complete folder and import ─────────────────────────────────────────

async function scanCompleteFolder(
  settings: unknown,
  importService: ImportService
): Promise<void> {
  const settingsWithHa = {
    ...settings,
    downloadFolderPaths: [...settings.downloadFolderPaths, 'hasoulseek/complete']
  }

  // Collect all audio files under hasoulseek/complete
  const completeDir = resolve(settings.musicFolderPath, 'hasoulseek/complete')
  const audioFiles = await collectAudioFiles(completeDir)

  if (audioFiles.length === 0) {
    console.log('\n[scan] No audio files found in hasoulseek/complete.')
    return
  }

  console.log(`\n[scan] Found ${audioFiles.length} audio file(s) in hasoulseek/complete:`)
  for (const f of audioFiles) {
    console.log('   ', f.replace(settings.musicFolderPath + '/', ''))
  }

  for (const filePath of audioFiles) {
    const name = basename(filePath)
    const parsed = parseSongFilename(name)

    if (!parsed) {
      console.log(`\n[scan] Could not parse filename: ${name} — skipping`)
      continue
    }

    const { artist, title, version } = parsed
    console.log(
      `\n══ ${artist} - ${title}${version ? ` (${version})` : ''} ══`
    )
    console.log(`    source: ${filePath.replace(settings.musicFolderPath + '/', '')}`)

    console.log('[import] Identifying via Discogs...')
    const importResult = await importService.importFile(
      settingsWithHa,
      artist,
      title,
      version,
      filePath
    )
    printImportResult(importResult)
  }
}

async function collectAudioFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectAudioFiles(full)))
    } else if (entry.isFile() && AUDIO_EXTS.has(extname(entry.name).toLowerCase())) {
      files.push(full)
    }
  }
  return files
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const settings = await loadSettings()
  const svc = new SlskdService()
  const importService = new ImportService(
    new DiscogsMatchService(),
    new TaggerService(),
    new OnlineSearchService()
  )

  console.log('=== slskd integration script ===')
  console.log('baseURL:', settings.slskdBaseURL)
  console.log('musicFolder:', settings.musicFolderPath)

  // ── Demo: search + download + import Crispy Bacon ─────────────────────────
  // await searchDownloadImport(svc, importService, settings, 'Laurent Garnier', 'Crispy Bacon', null)

  // ── Scan complete folder and import everything found ──────────────────────
  await scanCompleteFolder(settings, importService)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  console.error(err)
  process.exit(1)
})

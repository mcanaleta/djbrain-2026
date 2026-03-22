#!/usr/bin/env tsx
/**
 * Export an existing settings.json to .env format for Docker.
 *
 * Usage:
 *   npx tsx scripts/export-env.ts [path/to/settings.json]
 *
 * Defaults to .djbrain-data/settings.json if no path is given.
 * Output goes to stdout — redirect to .env:
 *   npx tsx scripts/export-env.ts > .env
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SETTINGS_TO_ENV: Record<string, string> = {
  musicFolderPath: 'DJBRAIN_MUSIC_FOLDER_PATH',
  songsFolderPath: 'DJBRAIN_SONGS_FOLDER_PATH',
  downloadFolderPaths: 'DJBRAIN_DOWNLOAD_FOLDER_PATHS',
  slskdBaseURL: 'DJBRAIN_SLSKD_BASE_URL',
  slskdApiKey: 'DJBRAIN_SLSKD_API_KEY',
  discogsUserToken: 'DJBRAIN_DISCOGS_USER_TOKEN',
  grokApiKey: 'DJBRAIN_GROK_API_KEY',
  serperApiKey: 'DJBRAIN_SERPER_API_KEY',
  youtubeApiKey: 'DJBRAIN_YOUTUBE_API_KEY'
}

const settingsPath = resolve(process.argv[2] || '.djbrain-data/settings.json')

let settings: Record<string, unknown>
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
} catch (err) {
  console.error(`Failed to read ${settingsPath}: ${err}`)
  process.exit(1)
}

console.log('# Generated from ' + settingsPath)
console.log('# ' + new Date().toISOString())
console.log('')

for (const [key, envKey] of Object.entries(SETTINGS_TO_ENV)) {
  const value = settings[key]
  if (value === undefined || value === null || value === '') {
    console.log(`${envKey}=`)
  } else if (Array.isArray(value)) {
    console.log(`${envKey}=${value.join(',')}`)
  } else {
    console.log(`${envKey}=${String(value)}`)
  }
}

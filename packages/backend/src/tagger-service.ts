import { execFileSync } from 'node:child_process'
import NodeID3 from 'node-id3'
import { extname } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AudioTags = {
  artist: string
  title: string
  album: string | null
  year: string | null
  label: string | null
  catalogNumber: string | null
  trackPosition: string | null
  discogsReleaseId: number | null
  discogsTrackPosition: string | null
}

// ─── Supported formats ────────────────────────────────────────────────────────

// node-id3 handles ID3 tags for these formats (ID3v2 embedded in the file)
const ID3_SUPPORTED = new Set(['.mp3', '.aif', '.aiff', '.wav'])

type ProbeData = {
  format?: {
    tags?: Record<string, string | undefined>
  }
}

// FLAC uses Vorbis comments — not handled by node-id3.
// For now we skip tag-writing on FLAC and still move the file.
// TODO: add flac-bindings support when needed.

// ─── Service ──────────────────────────────────────────────────────────────────

export class TaggerService {
  supportsFile(filePath: string): boolean {
    return ID3_SUPPORTED.has(extname(filePath).toLowerCase())
  }

  readTags(filePath: string): AudioTags | null {
    if (this.supportsFile(filePath)) {
      return this.readID3Tags(filePath)
    }
    if (extname(filePath).toLowerCase() === '.flac') {
      return this.readFlacTags(filePath)
    }
    return null
  }

  private readID3Tags(filePath: string): AudioTags | null {
    const raw = NodeID3.read(filePath)
    if (!raw || raw instanceof Error) return null
    const userDefinedText = Array.isArray(raw.userDefinedText)
      ? raw.userDefinedText
      : raw.userDefinedText
        ? [raw.userDefinedText]
        : []
    const findUserValue = (description: string): string | null => {
      const match = userDefinedText.find((item) => {
        const current = typeof item === 'object' && item !== null && 'description' in item ? item.description : null
        return typeof current === 'string' && current.toUpperCase() === description
      })
      if (!match || typeof match !== 'object' || match === null || !('value' in match)) return null
      return typeof match.value === 'string' ? match.value : null
    }
    const discogsReleaseId = Number(findUserValue('DISCOGS_RELEASE_ID') ?? '')
    return {
      artist: raw.artist?.trim() || '',
      title: raw.title?.trim() || '',
      album: raw.album?.trim() || null,
      year: raw.year?.trim() || null,
      label: raw.publisher?.trim() || null,
      catalogNumber: findUserValue('DISCOGS_CATALOG_NUMBER'),
      trackPosition: raw.trackNumber?.trim() || null,
      discogsReleaseId: Number.isFinite(discogsReleaseId) ? discogsReleaseId : null,
      discogsTrackPosition: findUserValue('DISCOGS_TRACK_POSITION')
    }
  }

  private readFlacTags(filePath: string): AudioTags | null {
    try {
      const probe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath], {
          encoding: 'utf8'
        })
      ) as ProbeData
      const tags = probe.format?.tags ?? {}
      const findValue = (...keys: string[]): string | null => {
        for (const key of keys) {
          const value = Object.entries(tags).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1]
          if (typeof value === 'string' && value.trim()) return value.trim()
        }
        return null
      }
      const discogsReleaseId = Number(findValue('DISCOGS_RELEASE_ID') ?? '')
      return {
        artist: findValue('artist') ?? '',
        title: findValue('title') ?? '',
        album: findValue('album'),
        year: findValue('year', 'date'),
        label: findValue('publisher', 'label'),
        catalogNumber: findValue('DISCOGS_CATALOG_NUMBER'),
        trackPosition: findValue('track', 'tracknumber'),
        discogsReleaseId: Number.isFinite(discogsReleaseId) ? discogsReleaseId : null,
        discogsTrackPosition: findValue('DISCOGS_TRACK_POSITION')
      }
    } catch {
      return null
    }
  }

  /**
   * Write metadata tags to an audio file.
   * Returns true if tags were written, false if the format is not yet supported.
   */
  async writeTags(filePath: string, tags: AudioTags): Promise<boolean> {
    if (this.supportsFile(filePath)) {
      await this.writeID3Tags(filePath, tags)
      return true
    }

    console.warn(`[tagger] skipping tag write for unsupported format: ${extname(filePath).toLowerCase()}`)
    return false
  }

  private async writeID3Tags(filePath: string, tags: AudioTags): Promise<void> {
    const userDefinedText: Array<{ description: string; value: string }> = []

    if (tags.discogsReleaseId !== null) {
      userDefinedText.push({
        description: 'DISCOGS_RELEASE_ID',
        value: String(tags.discogsReleaseId)
      })
    }

    if (tags.discogsTrackPosition !== null) {
      userDefinedText.push({
        description: 'DISCOGS_TRACK_POSITION',
        value: tags.discogsTrackPosition
      })
    }

    if (tags.catalogNumber !== null) {
      userDefinedText.push({
        description: 'DISCOGS_CATALOG_NUMBER',
        value: tags.catalogNumber
      })
    }

    const id3Tags: NodeID3.Tags = {
      title: tags.title,
      artist: tags.artist,
      ...(tags.album ? { album: tags.album } : {}),
      ...(tags.year ? { year: tags.year } : {}),
      ...(tags.label ? { publisher: tags.label } : {}),
      ...(tags.trackPosition ? { trackNumber: tags.trackPosition } : {}),
      ...(userDefinedText.length > 0 ? { userDefinedText } : {})
    }

    const result = NodeID3.write(id3Tags, filePath)
    if (result instanceof Error) {
      throw new Error(`Failed to write ID3 tags to ${filePath}: ${result.message}`)
    }
  }
}

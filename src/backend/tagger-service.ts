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

// FLAC uses Vorbis comments — not handled by node-id3.
// For now we skip tag-writing on FLAC and still move the file.
// TODO: add flac-bindings support when needed.

// ─── Service ──────────────────────────────────────────────────────────────────

export class TaggerService {
  supportsFile(filePath: string): boolean {
    return ID3_SUPPORTED.has(extname(filePath).toLowerCase())
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

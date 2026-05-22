export type PurchaseMetadata = {
  artist: string | null
  title: string | null
  version: string | null
  year?: string | null
  catalogNumber?: string | null
  trackPosition?: string | null
}

function text(value: string | null | undefined): string | null {
  return value?.replace(/\s+/g, ' ').trim() || null
}

export function cleanPurchaseMetadata(input: PurchaseMetadata): Required<PurchaseMetadata> {
  let artist = text(input.artist)
  let catalogNumber = text(input.catalogNumber)
  let trackPosition = text(input.trackPosition)
  const lead = artist?.match(/^((?:[a-z]{1,4}[- ]?\d+)|(?:[a-z]\d+))\.?\s+(.+)$/i)
  if (lead) {
    const code = lead[1].replace(/\s+/g, '').toUpperCase()
    if (/^[A-Z]\d+$/.test(code)) trackPosition ??= code
    else catalogNumber ??= code
    artist = text(lead[2])
  }
  return {
    artist,
    title: text(input.title)?.replace(/\s+mp3$/i, '') || null,
    version: text(input.version),
    year: text(input.year) ?? String(new Date().getFullYear()),
    catalogNumber,
    trackPosition
  }
}

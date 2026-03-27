export function extractYouTubeId(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1) || null
    }
    if (url.hostname.includes('youtube.com')) {
      return url.searchParams.get('v')
    }
    return null
  } catch {
    return null
  }
}

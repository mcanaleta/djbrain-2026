import { useEffect, useState } from 'react'
import type { DiscogsTrackSearchResult } from '../../../../shared/api'
import { api } from '../../api/client'
import { ActionButton } from '../../components/view/ActionButton'
import { Notice } from '../../components/view/Notice'
import { Overlay } from '../../components/view/Overlay'
import { useYoutubePlayer } from '../../context/YoutubePlayerContext'
import { formatCompactDuration } from '../../lib/music-file'
import { getErrorMessage } from '../../lib/error-utils'

function label(row: DiscogsTrackSearchResult): string {
  return `${row.artist} - ${row.title}${row.version ? ` (${row.version})` : ''}`
}

export function DiscogsTrackAssignDialog({
  filename,
  initialQuery,
  onClose,
  onAssigned
}: {
  filename: string
  initialQuery: string
  onClose: () => void
  onAssigned: () => Promise<void>
}): React.JSX.Element {
  const [query, setQuery] = useState(initialQuery)
  const [rows, setRows] = useState<DiscogsTrackSearchResult[]>([])
  const [busy, setBusy] = useState<'search' | 'assign' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { activeVideoId, setActiveVideo } = useYoutubePlayer()

  async function search(nextQuery = query): Promise<void> {
    const trimmed = nextQuery.trim()
    if (!trimmed) return
    setBusy('search')
    setError(null)
    try {
      setRows(await api.onlineSearch.searchDiscogsTracks(trimmed))
    } catch (err) {
      setError(getErrorMessage(err, 'Discogs search failed'))
    } finally {
      setBusy(null)
    }
  }

  async function assign(row: DiscogsTrackSearchResult): Promise<void> {
    setBusy('assign')
    setError(null)
    try {
      await api.collection.assignDiscogsTrack(filename, row)
      await onAssigned()
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Discogs assignment failed'))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void search(initialQuery)
  }, [])

  return (
    <Overlay title="Assign Discogs Track" onClose={onClose}>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search() }}>
        <input
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <ActionButton type="submit" size="sm" tone="primary" disabled={busy === 'search' || !query.trim()}>
          {busy === 'search' ? 'Searching...' : 'Search'}
        </ActionButton>
      </form>
      {error ? <Notice tone="error" className="mt-2 text-sm">{error}</Notice> : null}
      <div className="mt-3 max-h-[70vh] overflow-auto rounded border border-zinc-800">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-950 text-left uppercase text-zinc-500">
            <tr>
              {['Artist', 'Title', 'Release', 'Year', 'Format', 'Duration', 'YouTube', 'Link', ''].map((head) => (
                <th key={head} className="px-2 py-1.5 font-medium">{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.releaseId}-${row.trackPosition}-${label(row)}`} className="border-t border-zinc-800/70 hover:bg-zinc-900/50">
                <td className="px-2 py-1.5 text-zinc-100">{row.artist}</td>
                <td className="px-2 py-1.5 text-zinc-100">{row.title}{row.version ? <span className="text-zinc-500"> ({row.version})</span> : null}</td>
                <td className="px-2 py-1.5 text-zinc-300">{row.releaseTitle}</td>
                <td className="px-2 py-1.5 text-zinc-400">{row.year ?? ''}</td>
                <td className="px-2 py-1.5 text-zinc-400">{row.format ?? ''}</td>
                <td className="px-2 py-1.5 text-zinc-400">{formatCompactDuration(row.durationSeconds ?? null)}</td>
                <td className="px-2 py-1.5">
                  {row.youtubeVideoId ? (
                    <ActionButton
                      size="xs"
                      tone={activeVideoId === row.youtubeVideoId ? 'primary' : 'default'}
                      title={row.youtubeTitle ?? label(row)}
                      onClick={() => setActiveVideo(activeVideoId === row.youtubeVideoId ? null : row.youtubeVideoId, row.youtubeTitle ?? label(row))}
                    >
                      {activeVideoId === row.youtubeVideoId ? 'Playing' : 'Play'}
                    </ActionButton>
                  ) : <span className="text-zinc-600">-</span>}
                </td>
                <td className="px-2 py-1.5"><a className="text-sky-300 hover:text-sky-200" href={row.externalUrl} target="_blank" rel="noreferrer">Open</a></td>
                <td className="px-2 py-1.5 text-right">
                  <ActionButton size="xs" tone="primary" disabled={busy === 'assign'} onClick={() => void assign(row)}>
                    Assign
                  </ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && rows.length === 0 ? <div className="p-3 text-sm text-zinc-500">No Discogs tracks found.</div> : null}
      </div>
    </Overlay>
  )
}

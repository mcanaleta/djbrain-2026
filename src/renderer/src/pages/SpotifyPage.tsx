export default function SpotifyPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-sm font-semibold text-zinc-100">Spotify</div>
        <div className="mt-1 text-sm text-zinc-400">Auth + library sync placeholder (stub UI).</div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-100 hover:bg-zinc-950/60"
          >
            Connect (stub)
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-100 hover:bg-zinc-950/60"
          >
            Sync playlists (stub)
          </button>
        </div>
      </div>
    </div>
  )
}

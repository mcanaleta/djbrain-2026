export default function DropboxPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-sm font-semibold text-zinc-100">Dropbox</div>
        <div className="mt-1 text-sm text-zinc-400">Connect + sync flow placeholder (stub UI).</div>

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
            Sync now (stub)
          </button>
        </div>
      </div>
    </div>
  )
}

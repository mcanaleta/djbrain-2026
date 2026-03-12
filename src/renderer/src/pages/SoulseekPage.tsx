export default function SoulseekPage(): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-sm font-semibold text-zinc-100">Soulseek</div>
        <div className="mt-1 text-sm text-zinc-400">slskd status placeholder (stub UI).</div>

        <div className="mt-4 space-y-2 text-sm text-zinc-200">
          <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/30 px-3 py-2">
            <span className="text-zinc-400">Server</span>
            <span>—</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/30 px-3 py-2">
            <span className="text-zinc-400">Downloads</span>
            <span>—</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/30 px-3 py-2">
            <span className="text-zinc-400">Uploads</span>
            <span>—</span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-sm font-semibold text-zinc-100">Downloads</div>
        <div className="mt-1 text-sm text-zinc-400">Queue placeholder (stub UI).</div>

        <div className="mt-4 text-sm text-zinc-200">
          <div className="rounded-md border border-dashed border-zinc-700 bg-zinc-950/20 px-3 py-6 text-center text-zinc-400">
            No active downloads (stub)
          </div>
        </div>
      </div>
    </div>
  )
}

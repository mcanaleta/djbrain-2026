function Versions(): React.JSX.Element {
  return (
    <ul className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-300">
      <li className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">Browser mode</li>
      <li className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">React Router v7</li>
      <li className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">Local API server</li>
    </ul>
  )
}

export default Versions

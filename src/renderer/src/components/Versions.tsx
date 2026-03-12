function Versions(): React.JSX.Element {
  const versions = window.electron.process.versions

  return (
    <ul className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-300">
      <li className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">
        Electron v{versions.electron}
      </li>
      <li className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">
        Chromium v{versions.chrome}
      </li>
      <li className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">
        Node v{versions.node}
      </li>
    </ul>
  )
}

export default Versions

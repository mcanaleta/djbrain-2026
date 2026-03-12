import { NavLink } from 'react-router-dom'
import * as Separator from '@radix-ui/react-separator'
import { NAV_ITEMS } from '../app/nav'

export default function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/80 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-base font-semibold text-zinc-100">DJBrain</div>
        <div className="text-xs text-zinc-500">2026</div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isSettings = item.key === 'settings'
          return (
            <NavLink
              key={item.key}
              to={item.path}
              className={({ isActive }) =>
                [
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-zinc-900/60 text-zinc-100'
                    : 'text-zinc-300 hover:bg-zinc-900/40 hover:text-zinc-100',
                  isSettings ? 'mt-auto' : ''
                ].join(' ')
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          )
        })}
      </nav>

      <Separator.Root className="my-4 h-px w-full bg-zinc-800" />
      <div className="text-xs text-zinc-500">Local-first DJ manager. UI scaffold only.</div>
    </aside>
  )
}

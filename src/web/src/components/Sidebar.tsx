import { NavLink } from 'react-router-dom'
import * as Separator from '@radix-ui/react-separator'
import { DoubleArrowLeftIcon, DoubleArrowRightIcon } from '@radix-ui/react-icons'
import { NAV_ITEMS } from '../app/nav'

export default function Sidebar({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <aside className={`flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/80 p-3 transition-all ${collapsed ? 'w-16' : 'w-60'}`}>
      <div className={`mb-4 flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
        {!collapsed ? <div className="text-base font-semibold text-zinc-100">DJBrain</div> : null}
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-900/70 hover:text-zinc-100"
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          {collapsed ? <DoubleArrowRightIcon className="h-4 w-4" /> : <DoubleArrowLeftIcon className="h-4 w-4" />}
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.key}
              to={item.path}
              title={collapsed ? item.label : undefined}
              aria-label={item.label}
              className={({ isActive }) =>
                [
                  `flex items-center rounded-md px-3 py-2 text-sm transition-colors ${collapsed ? 'justify-center' : 'gap-2'}`,
                  isActive
                    ? 'bg-zinc-900/60 text-zinc-100'
                    : 'text-zinc-300 hover:bg-zinc-900/40 hover:text-zinc-100'
                ].join(' ')
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed ? <span className="truncate">{item.label}</span> : null}
            </NavLink>
          )
        })}
      </nav>

      {!collapsed ? (
        <>
          <Separator.Root className="my-4 h-px w-full bg-zinc-800" />
          <div className="text-xs text-zinc-500">Browser-first DJ manager with local demo data.</div>
        </>
      ) : null}
    </aside>
  )
}

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DotsHorizontalIcon } from '@radix-ui/react-icons'
import { useLocation } from 'react-router-dom'
import { resolveNavTitle } from '../app/nav'
import { useHeaderActionsState } from '../context/HeaderActionsContext'

const menuItemClassName =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-sm text-zinc-200 outline-none focus:bg-zinc-900 data-[disabled]:opacity-50'

export default function TopBar(): React.JSX.Element {
  const location = useLocation()
  const title = resolveNavTitle(location.pathname)
  const actions = useHeaderActionsState()

  return (
    <header className="flex h-12 items-center gap-3 border-b border-zinc-800 bg-zinc-950/60 px-4">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold text-zinc-100">{title}</h1>
      </div>
      <div className="flex-1" />

      {actions.length > 0 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-100 hover:bg-zinc-900/60"
              aria-label="Actions"
            >
              <DotsHorizontalIcon />
              Actions
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              sideOffset={8}
              className="min-w-52 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-lg"
            >
              {actions.map((action) => {
                const Icon = action.icon
                return (
                  <DropdownMenu.Item
                    key={action.key}
                    className={menuItemClassName}
                    disabled={action.disabled}
                    onSelect={() => {
                      void action.onSelect()
                    }}
                  >
                    {Icon ? <Icon /> : null}
                    {action.label}
                  </DropdownMenu.Item>
                )
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </header>
  )
}

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DotsHorizontalIcon } from '@radix-ui/react-icons'
import type { ImportRecordFileRow } from './importRecordFiles'

export type ImportRecordFileUtilityAction = 'reanalyze' | 'show' | 'open'

const itemClass =
  'flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:bg-zinc-800 data-[disabled]:opacity-50'

const ACTIONS = [
  ['reanalyze', 'Reanalyze audio/hash'],
  ['open', 'Open in player'],
  ['show', 'Show in folder']
] as const

export function ImportRecordFileMenu({
  row,
  disabled,
  onAction
}: {
  row: ImportRecordFileRow
  disabled: boolean
  onAction: (action: ImportRecordFileUtilityAction, row: ImportRecordFileRow) => void
}): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`File actions for ${row.filename}`}
          title="File actions"
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
        >
          <DotsHorizontalIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={4} align="end" className="z-50 min-w-40 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-lg">
          {ACTIONS.map(([action, label]) => (
            <DropdownMenu.Item
              key={action}
              className={itemClass}
              onSelect={() => onAction(action, row)}
            >
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

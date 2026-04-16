import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react'

export type HeaderAction = {
  key: string
  label: string
  onSelect: () => void | Promise<void>
  disabled?: boolean
  icon?: ComponentType<{ className?: string }>
}

const HeaderActionsContext = createContext<{
  actions: HeaderAction[]
  setActions: (actions: HeaderAction[]) => void
} | null>(null)

export function HeaderActionsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [actions, setActions] = useState<HeaderAction[]>([])
  return <HeaderActionsContext.Provider value={{ actions, setActions }}>{children}</HeaderActionsContext.Provider>
}

export function useHeaderActions(actions: HeaderAction[]): void {
  const context = useContext(HeaderActionsContext)
  if (!context) throw new Error('HeaderActionsProvider is missing.')
  useEffect(() => {
    context.setActions(actions)
    return () => {
      context.setActions([])
    }
  }, [actions, context])
}

export function useHeaderActionsState(): HeaderAction[] {
  const context = useContext(HeaderActionsContext)
  if (!context) throw new Error('HeaderActionsProvider is missing.')
  return context.actions
}

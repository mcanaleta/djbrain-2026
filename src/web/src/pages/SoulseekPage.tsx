import { EmptyState } from '../components/view/EmptyState'
import { ViewPanel } from '../components/view/ViewPanel'
import { ViewSection } from '../components/view/ViewSection'

export default function SoulseekPage(): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ViewSection title="Soulseek" subtitle="slskd status placeholder (stub UI).">
        <div className="mt-4 space-y-2 text-sm text-zinc-200">
          <ViewPanel tone="muted" padding="sm" className="flex items-center justify-between px-3 py-2">
            <span className="text-zinc-400">Server</span>
            <span>—</span>
          </ViewPanel>
          <ViewPanel tone="muted" padding="sm" className="flex items-center justify-between px-3 py-2">
            <span className="text-zinc-400">Downloads</span>
            <span>—</span>
          </ViewPanel>
          <ViewPanel tone="muted" padding="sm" className="flex items-center justify-between px-3 py-2">
            <span className="text-zinc-400">Uploads</span>
            <span>—</span>
          </ViewPanel>
        </div>
      </ViewSection>

      <ViewSection title="Downloads" subtitle="Queue placeholder (stub UI).">
        <EmptyState message="No active downloads (stub)" className="border-dashed py-6 text-center text-sm" />
      </ViewSection>
    </div>
  )
}

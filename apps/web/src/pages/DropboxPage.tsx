import { ActionButton } from '../components/view/ActionButton'
import { ViewSection } from '../components/view/ViewSection'

export default function DropboxPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <ViewSection title="Dropbox" subtitle="Connect + sync flow placeholder (stub UI).">
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton type="button">
            Connect (stub)
          </ActionButton>
          <ActionButton type="button">
            Sync now (stub)
          </ActionButton>
        </div>
      </ViewSection>
    </div>
  )
}

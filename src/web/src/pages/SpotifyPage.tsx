import { ActionButton } from '../components/view/ActionButton'
import { ViewSection } from '../components/view/ViewSection'

export default function SpotifyPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <ViewSection title="Spotify" subtitle="Auth + library sync placeholder (stub UI).">
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton type="button">
            Connect (stub)
          </ActionButton>
          <ActionButton type="button">
            Sync playlists (stub)
          </ActionButton>
        </div>
      </ViewSection>
    </div>
  )
}

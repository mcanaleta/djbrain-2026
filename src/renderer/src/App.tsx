import {
  Navigate,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements
} from 'react-router-dom'
import AppShell from './layout/AppShell'
import CollectionPage from './pages/CollectionPage'
import WantlistPage from './pages/WantlistPage'
import WantlistItemPage from './pages/WantlistItemPage'
import DiscogsEntityPage from './pages/DiscogsEntityPage'
import DropboxPage from './pages/DropboxPage'
import GrokSearchPage from './pages/GrokSearchPage'
import ImportPage from './pages/ImportPage'
import SearchOnlinePage from './pages/SearchOnlinePage'
import SettingsPage from './pages/SettingsPage'
import SoulseekPage from './pages/SoulseekPage'
import SpotifyPage from './pages/SpotifyPage'

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<AppShell />}>
      <Route path="/" element={<Navigate to="/collection" replace />} />
      <Route path="/collection" element={<CollectionPage />} />
      <Route path="/wantlist" element={<WantlistPage />} />
      <Route path="/wantlist/:wantId" element={<WantlistItemPage />} />
      <Route path="/discogs/release/:discogsId" element={<DiscogsEntityPage entityType="release" />} />
      <Route path="/discogs/artist/:discogsId" element={<DiscogsEntityPage entityType="artist" />} />
      <Route path="/discogs/label/:discogsId" element={<DiscogsEntityPage entityType="label" />} />
      <Route path="/discogs/master/:discogsId" element={<DiscogsEntityPage entityType="master" />} />
      <Route path="/search-online" element={<SearchOnlinePage />} />
      <Route path="/grok-search" element={<GrokSearchPage />} />
      <Route path="/soulseek" element={<SoulseekPage />} />
      <Route path="/spotify" element={<SpotifyPage />} />
      <Route path="/import" element={<ImportPage />} />
      <Route path="/dropbox" element={<DropboxPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Route>
  )
)

function App(): React.JSX.Element {
  return <RouterProvider router={router} />
}

export default App

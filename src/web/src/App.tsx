import {
  Navigate,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements
} from 'react-router-dom'
import AppShell from './layout/AppShell'
import CollectionPage from './pages/CollectionPage'
import CollectionItemPage from './pages/CollectionItemPage'
import LegacyCollectionItemPage from './pages/LegacyCollectionItemPage'
import FilePage from './pages/FilePage'
import WantlistPage from './pages/WantlistPage'
import WantlistItemPage from './pages/WantlistItemPage'
import DiscogsReleasePage from './pages/DiscogsReleasePage'
import DiscogsMasterPage from './pages/DiscogsMasterPage'
import DiscogsArtistPage from './pages/DiscogsArtistPage'
import DiscogsLabelPage from './pages/DiscogsLabelPage'
import DropboxPage from './pages/DropboxPage'
import GrokSearchPage from './pages/GrokSearchPage'
import ImportPage from './pages/ImportPage'
import ImportRecordPage from './pages/ImportRecordPage'
import ImportReviewPage from './pages/ImportReviewPage'
import IdentifyPage from './pages/IdentifyPage'
import IdentifyItemPage from './pages/IdentifyItemPage'
import SearchOnlinePage from './pages/SearchOnlinePage'
import SoulseekPage from './pages/SoulseekPage'
import SpotifyPage from './pages/SpotifyPage'
import RecordingPage from './pages/RecordingPage'
import RecordingsPage from './pages/RecordingsPage'
import UpgradesPage from './pages/UpgradesPage'
import UpgradeCasePage from './pages/UpgradeCasePage'

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<AppShell />}>
      <Route path="/" element={<Navigate to="/collection" replace />} />
      <Route path="/collection" element={<CollectionPage />} />
      <Route path="/collection/item" element={<LegacyCollectionItemPage />} />
      <Route path="/file/:itemId" element={<FilePage />} />
      <Route path="/item/:itemId" element={<CollectionItemPage />} />
      <Route path="/wantlist" element={<WantlistPage />} />
      <Route path="/wantlist/:wantId" element={<WantlistItemPage />} />
      <Route path="/discogs/release/:discogsId" element={<DiscogsReleasePage />} />
      <Route path="/discogs/artist/:discogsId" element={<DiscogsArtistPage />} />
      <Route path="/discogs/label/:discogsId" element={<DiscogsLabelPage />} />
      <Route path="/discogs/master/:discogsId" element={<DiscogsMasterPage />} />
      <Route path="/search-online" element={<Navigate to="/discogs-search" replace />} />
      <Route path="/discogs-search" element={<SearchOnlinePage />} />
      <Route path="/grok-search" element={<GrokSearchPage />} />
      <Route path="/soulseek" element={<SoulseekPage />} />
      <Route path="/spotify" element={<SpotifyPage />} />
      <Route path="/import" element={<ImportPage />} />
      <Route path="/import/review/:itemId" element={<ImportReviewPage />} />
      <Route path="/import/:recordingId" element={<ImportRecordPage />} />
      <Route path="/identify" element={<IdentifyPage />} />
      <Route path="/identify/:itemId" element={<IdentifyItemPage />} />
      <Route path="/recordings" element={<RecordingsPage />} />
      <Route path="/recordings/:recordingId" element={<RecordingPage />} />
      <Route path="/upgrades" element={<UpgradesPage />} />
      <Route path="/upgrades/:upgradeId" element={<UpgradeCasePage />} />
      <Route path="/dropbox" element={<DropboxPage />} />
    </Route>
  )
)

function App(): React.JSX.Element {
  return <RouterProvider router={router} />
}

export default App

import { useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import NowPlayingBar from '../components/NowPlayingBar'
import Sidebar from '../components/Sidebar'
import TopBar from '../components/TopBar'
import { PlayerProvider } from '../context/PlayerContext'

export type SearchScope = 'collection' | 'discogs' | 'online'

export type SubmittedSearch = {
  scope: SearchScope
  query: string
  submittedAt: number
}

export type AppShellOutletContext = {
  submittedSearch: SubmittedSearch
}

export default function AppShell(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState<SubmittedSearch>({
    scope: 'collection',
    query: '',
    submittedAt: 0
  })

  const handleSearchSubmit = (scope: SearchScope): void => {
    const trimmedQuery = searchQuery.trim()
    setSubmittedSearch({
      scope,
      query: trimmedQuery,
      submittedAt: Date.now()
    })

    if (scope === 'collection') {
      navigate('/collection')
      return
    }

    navigate('/search-online')
  }

  return (
    <PlayerProvider>
      <div className="flex h-full w-full bg-zinc-950">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchSubmit={handleSearchSubmit}
          />
          <main className="min-h-0 flex-1 overflow-auto p-6">
            <Outlet context={{ submittedSearch }} />
          </main>
          <NowPlayingBar />
        </div>
      </div>
    </PlayerProvider>
  )
}

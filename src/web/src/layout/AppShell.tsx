import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import NowPlayingBar from '../components/NowPlayingBar'
import Sidebar from '../components/Sidebar'
import TopBar from '../components/TopBar'
import { PlayerProvider } from '../context/PlayerContext'
import { FloatingYoutubePlayer, YoutubePlayerProvider } from '../context/YoutubePlayerContext'

export default function AppShell(): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <PlayerProvider>
      <YoutubePlayerProvider>
        <div className="flex h-full w-full bg-zinc-950">
          <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar />
            <main className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
              <Outlet />
            </main>
            <NowPlayingBar />
          </div>
        </div>
        <FloatingYoutubePlayer />
      </YoutubePlayerProvider>
    </PlayerProvider>
  )
}

import { createContext, useContext, useState } from 'react'

type YoutubePlayerContextValue = {
  activeVideoId: string | null
  activeVideoTitle: string | null
  setActiveVideo: (id: string | null, title?: string | null) => void
}

const YoutubePlayerContext = createContext<YoutubePlayerContextValue>({
  activeVideoId: null,
  activeVideoTitle: null,
  setActiveVideo: () => {}
})

export function useYoutubePlayer(): YoutubePlayerContextValue {
  return useContext(YoutubePlayerContext)
}

export function YoutubePlayerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [activeVideoTitle, setActiveVideoTitle] = useState<string | null>(null)

  const setActiveVideo = (id: string | null, title?: string | null): void => {
    setActiveVideoId(id)
    setActiveVideoTitle(title ?? null)
  }

  return (
    <YoutubePlayerContext.Provider value={{ activeVideoId, activeVideoTitle, setActiveVideo }}>
      {children}
    </YoutubePlayerContext.Provider>
  )
}

export function FloatingYoutubePlayer(): React.JSX.Element | null {
  const { activeVideoId, activeVideoTitle, setActiveVideo } = useYoutubePlayer()
  if (!activeVideoId) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="truncate text-xs text-zinc-400">{activeVideoTitle ?? 'YouTube'}</span>
        <button
          onClick={() => setActiveVideo(null)}
          className="shrink-0 text-zinc-500 hover:text-zinc-200"
          aria-label="Close player"
        >
          ✕
        </button>
      </div>
      <div className="aspect-video w-full">
        <iframe
          src={`https://www.youtube.com/embed/${activeVideoId}?autoplay=1`}
          title={activeVideoTitle ?? 'YouTube video'}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          className="h-full w-full"
        />
      </div>
    </div>
  )
}

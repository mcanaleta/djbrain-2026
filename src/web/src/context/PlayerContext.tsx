import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlayerTrack = {
  /** /api/media?filename=relative/path/to/file.mp3 */
  url: string
  /** Relative filename from musicFolderPath — used as stable key */
  filename: string
  title: string
  artist: string
}

type PlayerContextValue = {
  track: PlayerTrack | null
  isPlaying: boolean
  currentTime: number
  duration: number
  /** Load and start playing a new track */
  play: (track: PlayerTrack) => void
  /** Toggle play/pause for the current track */
  toggle: () => void
  /** Seek to time in seconds */
  seek: (time: number) => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const defaultValue: PlayerContextValue = {
  track: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  play: () => {},
  toggle: () => {},
  seek: () => {}
}

export const PlayerContext = createContext<PlayerContextValue>(defaultValue)

export function usePlayer(): PlayerContextValue {
  return useContext(PlayerContext)
}

// ─── URL helper ───────────────────────────────────────────────────────────────
/**
 * Build a browser media URL from the configured music root and a relative filename.
 * The renderer uses this URL as the <audio> src.
 */
export function localFileUrl(musicFolderPath: string, relativeFilename: string): string {
  void musicFolderPath
  return `/api/media?filename=${encodeURIComponent(relativeFilename)}`
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function PlayerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [track, setTrack] = useState<PlayerTrack | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // While a seek is in flight we ignore timeupdate so the slider doesn't snap back.
  const isSeekingRef = useRef(false)
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stall recovery: if audio is waiting for data, nudge it back to current time.
  const stallRecoveryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the pending play() Promise so we never call pause() while it's in-flight.
  const pendingPlayRef = useRef<Promise<void> | null>(null)

  const log = useCallback((...args: unknown[]): void => console.log('[player]', ...args), [])

  const clearSeekTimeout = useCallback((): void => {
    if (seekTimeoutRef.current) {
      clearTimeout(seekTimeoutRef.current)
      seekTimeoutRef.current = null
    }
    isSeekingRef.current = false
  }, [])

  const clearStallRecovery = useCallback((): void => {
    if (stallRecoveryRef.current) {
      clearTimeout(stallRecoveryRef.current)
      stallRecoveryRef.current = null
    }
  }, [])

  const safePlay = useCallback((audio: HTMLAudioElement, reason: string): void => {
    log(
      `safePlay(${reason}) readyState=${audio.readyState} paused=${audio.paused} pending=${!!pendingPlayRef.current}`
    )
    const p = audio.play()
    pendingPlayRef.current = p
    p.then(
      () => {
        log(`safePlay(${reason}) resolved`)
        if (pendingPlayRef.current === p) pendingPlayRef.current = null
      },
      (err: unknown) => {
        log(`safePlay(${reason}) rejected:`, err)
        if (pendingPlayRef.current === p) pendingPlayRef.current = null
      }
    )
  }, [log])

  const safePause = useCallback((audio: HTMLAudioElement, reason: string): void => {
    if (pendingPlayRef.current) {
      log(`safePause(${reason}) — play pending, will pause after resolve`)
      pendingPlayRef.current.then(
        () => {
          log(`safePause(${reason}) deferred pause`)
          audio.pause()
        },
        () => {}
      )
      pendingPlayRef.current = null
    } else {
      log(`safePause(${reason}) immediate`)
      audio.pause()
    }
  }, [log])

  const loadTrack = useCallback((audio: HTMLAudioElement, nextTrack: PlayerTrack, reason: string): void => {
    clearSeekTimeout()
    clearStallRecovery()
    pendingPlayRef.current = null
    audio.src = nextTrack.url
    audio.load()
    audio.currentTime = 0
    setCurrentTime(0)
    setDuration(0)
    log(`loadTrack(${reason}) → ${nextTrack.filename}`)
    safePlay(audio, reason)
    setIsPlaying(true)
  }, [clearSeekTimeout, clearStallRecovery, log, safePlay])

  // When track changes, update src and play
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!track) {
      safePause(audio, 'track=null')
      audio.src = ''
      audio.load()
      clearSeekTimeout()
      clearStallRecovery()
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      return
    }
    loadTrack(audio, track, 'track-change')
  }, [clearSeekTimeout, clearStallRecovery, loadTrack, safePause, track])

  const play = (newTrack: PlayerTrack): void => {
    // If clicking the same track, just resume if paused
    if (track?.filename === newTrack.filename) {
      const audio = audioRef.current
      if (!audio) return
      if (audio.error) {
        log('play-same-track recovering from media error')
        loadTrack(audio, newTrack, 'play-same-track-recover')
        return
      }
      if (isPlaying) {
        safePause(audio, 'play-same-track')
        setIsPlaying(false)
      } else {
        safePlay(audio, 'play-same-track')
        setIsPlaying(true)
      }
      return
    }
    log(`play → ${newTrack.filename}`)
    setTrack(newTrack)
  }

  const toggle = (): void => {
    const audio = audioRef.current
    if (!audio || !track) return
    if (audio.error) {
      log('toggle recovering from media error')
      loadTrack(audio, track, 'toggle-recover')
      return
    }
    if (isPlaying) {
      safePause(audio, 'toggle')
      setIsPlaying(false)
    } else {
      safePlay(audio, 'toggle')
      setIsPlaying(true)
    }
  }

  const seek = useCallback((time: number): void => {
    const audio = audioRef.current
    if (!audio) return
    log(`seek → ${time.toFixed(2)}`)
    // Mark seeking so onTimeUpdate doesn't snap the slider back
    isSeekingRef.current = true
    clearSeekTimeout()
    isSeekingRef.current = true
    // Fallback: clear seeking flag after 3 s in case `seeked` never fires
    seekTimeoutRef.current = setTimeout(() => {
      isSeekingRef.current = false
      seekTimeoutRef.current = null
    }, 3000)
    audio.currentTime = time
    setCurrentTime(time)
  }, [clearSeekTimeout, log])

  useEffect(() => {
    return () => {
      clearSeekTimeout()
      clearStallRecovery()
    }
  }, [clearSeekTimeout, clearStallRecovery])

  return (
    <PlayerContext.Provider value={{ track, isPlaying, currentTime, duration, play, toggle, seek }}>
      {/* Hidden audio element — managed imperatively via ref */}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => {
          if (isSeekingRef.current) return
          setCurrentTime(e.currentTarget.currentTime)
        }}
        onSeeked={(e) => {
          log(`onSeeked → ${e.currentTarget.currentTime.toFixed(2)}`)
          clearSeekTimeout()
          setCurrentTime(e.currentTarget.currentTime)
        }}
        onDurationChange={(e) => {
          log(`onDurationChange → ${e.currentTarget.duration.toFixed(2)}`)
          setDuration(e.currentTarget.duration)
        }}
        onEnded={() => {
          log('onEnded')
          setIsPlaying(false)
        }}
        onPause={(e) => {
          log(`onPause currentTime=${e.currentTarget.currentTime.toFixed(2)}`)
          clearStallRecovery()
          setIsPlaying(false)
        }}
        onPlay={(e) => {
          log('onPlay')
          setIsPlaying(true)
          setCurrentTime(e.currentTarget.currentTime)
        }}
        onWaiting={() => {
          log('onWaiting — buffering')
          if (stallRecoveryRef.current) return
          stallRecoveryRef.current = setTimeout(() => {
            stallRecoveryRef.current = null
            const audio = audioRef.current
            if (!audio || audio.paused) return
            if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
            log('stall recovery — re-issuing play')
            safePlay(audio, 'stall-recovery')
          }, 1500)
        }}
        onError={(e) => {
          clearSeekTimeout()
          clearStallRecovery()
          pendingPlayRef.current = null
          setIsPlaying(false)
          log('onError', e.currentTarget.error)
        }}
        style={{ display: 'none' }}
      />
      {children}
    </PlayerContext.Provider>
  )
}

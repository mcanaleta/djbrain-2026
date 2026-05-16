import { useEffect, useRef, useState } from 'react'

type PlayMode = 'stopped' | 'source' | 'existing' | 'both'

export function useAudioCompare({
  sourceUrl,
  existingUrl,
  enabled,
  resetKey
}: {
  sourceUrl: string
  existingUrl: string
  enabled: boolean
  resetKey: string | number | null | undefined
}) {
  const [crossfade, setCrossfade] = useState(0)
  const [sourceTime, setSourceTime] = useState(0)
  const [existingTime, setExistingTime] = useState(0)
  const [sourceDuration, setSourceDuration] = useState(0)
  const [existingDuration, setExistingDuration] = useState(0)
  const [linkPlayers, setLinkPlayers] = useState(true)
  const [playMode, setPlayMode] = useState<PlayMode>('stopped')
  const sourceAudioRef = useRef<HTMLAudioElement>(null)
  const existingAudioRef = useRef<HTMLAudioElement>(null)

  const pausePlayback = (): void => {
    sourceAudioRef.current?.pause()
    existingAudioRef.current?.pause()
    setPlayMode('stopped')
  }

  const syncSourceTime = (time: number): void => {
    if (sourceAudioRef.current) sourceAudioRef.current.currentTime = time
    setSourceTime(time)
    if (linkPlayers && existingAudioRef.current) {
      existingAudioRef.current.currentTime = time
      setExistingTime(time)
    }
  }

  const syncExistingTime = (time: number): void => {
    if (existingAudioRef.current) existingAudioRef.current.currentTime = time
    setExistingTime(time)
    if (linkPlayers && sourceAudioRef.current) {
      sourceAudioRef.current.currentTime = time
      setSourceTime(time)
    }
  }

  const playSource = (): void => {
    const source = sourceAudioRef.current
    if (!source) return
    source.currentTime = sourceTime
    void source.play().catch(() => {})
    if (linkPlayers && enabled && existingAudioRef.current) {
      existingAudioRef.current.currentTime = source.currentTime
      void existingAudioRef.current.play().catch(() => {})
      setPlayMode('both')
      return
    }
    existingAudioRef.current?.pause()
    setPlayMode('source')
  }

  const playExisting = (): void => {
    const existing = existingAudioRef.current
    if (!existing || !enabled) return
    existing.currentTime = existingTime
    void existing.play().catch(() => {})
    if (linkPlayers && sourceAudioRef.current) {
      sourceAudioRef.current.currentTime = existing.currentTime
      void sourceAudioRef.current.play().catch(() => {})
      setPlayMode('both')
      return
    }
    sourceAudioRef.current?.pause()
    setPlayMode('existing')
  }

  useEffect(() => {
    const source = sourceAudioRef.current
    const existing = existingAudioRef.current
    if (!source) return
    source.volume = enabled ? (100 - crossfade) / 100 : 1
    if (existing) existing.volume = enabled ? crossfade / 100 : 0
  }, [crossfade, enabled])

  useEffect(() => {
    setSourceTime(0)
    setExistingTime(0)
    setSourceDuration(0)
    setExistingDuration(0)
    setCrossfade(0)
    setLinkPlayers(true)
    setPlayMode('stopped')
    sourceAudioRef.current?.pause()
    existingAudioRef.current?.pause()
  }, [resetKey])

  useEffect(
    () => () => {
      sourceAudioRef.current?.pause()
      existingAudioRef.current?.pause()
    },
    []
  )

  return {
    crossfade,
    setCrossfade,
    linkPlayers,
    setLinkPlayers,
    sourceTime,
    existingTime,
    sourceDuration,
    existingDuration,
    sourcePlaying: playMode === 'source' || playMode === 'both',
    existingPlaying: playMode === 'existing' || playMode === 'both',
    pausePlayback,
    syncSourceTime,
    syncExistingTime,
    playSource,
    playExisting,
    sourceAudioProps: {
      ref: sourceAudioRef,
      src: sourceUrl,
      preload: 'metadata' as const,
      onLoadedMetadata: () => {
        const nextDuration = sourceAudioRef.current?.duration ?? 0
        setSourceDuration(isFinite(nextDuration) ? nextDuration : 0)
      },
      onTimeUpdate: () => {
        if (!sourceAudioRef.current) return
        setSourceTime(sourceAudioRef.current.currentTime)
        if (
          linkPlayers &&
          playMode === 'both' &&
          existingAudioRef.current &&
          Math.abs(existingAudioRef.current.currentTime - sourceAudioRef.current.currentTime) > 0.12
        ) {
          existingAudioRef.current.currentTime = sourceAudioRef.current.currentTime
          setExistingTime(sourceAudioRef.current.currentTime)
        }
      },
      onEnded: pausePlayback
    },
    existingAudioProps: {
      ref: existingAudioRef,
      src: existingUrl,
      preload: 'metadata' as const,
      onLoadedMetadata: () => {
        const nextDuration = existingAudioRef.current?.duration ?? 0
        setExistingDuration(isFinite(nextDuration) ? nextDuration : 0)
      },
      onTimeUpdate: () => {
        if (!existingAudioRef.current) return
        setExistingTime(existingAudioRef.current.currentTime)
        if (
          linkPlayers &&
          playMode === 'both' &&
          sourceAudioRef.current &&
          Math.abs(sourceAudioRef.current.currentTime - existingAudioRef.current.currentTime) > 0.12
        ) {
          sourceAudioRef.current.currentTime = existingAudioRef.current.currentTime
          setSourceTime(existingAudioRef.current.currentTime)
        }
      },
      onEnded: pausePlayback
    }
  }
}

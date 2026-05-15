import { useEffect, useRef, useState } from 'react'
import { mixerPercentFromTime, mixerTimeFromPercent, toggleMixerSolo } from '../../../../shared/import-mixer'

export type ImportRecordMixerTrack = { filename: string; duration?: number | null }

export function useImportRecordMixer(tracks: ImportRecordMixerTrack[]): {
  needle: number
  playing: Set<string>
  solo: Set<string>
  onEnded: (filename: string) => void
  onLoaded: (filename: string) => void
  onTime: (filename: string) => void
  seek: (percent: number) => void
  setAudio: (filename: string, audio: HTMLAudioElement | null) => void
  toggleSolo: (filename: string) => void
} {
  const audio = useRef(new Map<string, HTMLAudioElement>())
  const filenames = tracks.map((track) => track.filename)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [needle, setNeedle] = useState(0)
  const [playing, setPlaying] = useState(new Set<string>())
  const [solo, setSolo] = useState(new Set<string>())
  const key = filenames.join('\0')

  useEffect(() => {
    const keep = new Set(filenames)
    setPlaying((current) => new Set([...current].filter((filename) => keep.has(filename))))
    setSolo((current) => new Set([...current].filter((filename) => keep.has(filename))))
  }, [key])

  const setAudio = (filename: string, element: HTMLAudioElement | null): void => {
    if (element) audio.current.set(filename, element)
    else audio.current.delete(filename)
  }

  const seek = (percent: number): void => {
    setNeedle(percent)
    audio.current.forEach((element) => {
      element.currentTime = mixerTimeFromPercent(percent, element.duration)
    })
  }

  const toggleSolo = (filename: string): void => {
    const element = audio.current.get(filename)
    if (!element) return
    if (playing.has(filename)) {
      element.pause()
      setPlaying(new Set())
      setSolo(new Set())
      return
    }
    audio.current.forEach((item) => item.pause())
    element.currentTime = mixerTimeFromPercent(needle, element.duration)
    element.muted = false
    setSolo(toggleMixerSolo(new Set(), filename))
    element.play().then(
      () => setPlaying(new Set([filename])),
      () => {
        setPlaying(new Set())
        setSolo(new Set())
      }
    )
  }

  return {
    needle,
    playing,
    solo,
    onEnded: () => {
      setPlaying(new Set())
      setSolo(new Set())
    },
    onLoaded: (filename) => {
      const value = audio.current.get(filename)?.duration ?? 0
      setDurations((current) => ({ ...current, [filename]: Number.isFinite(value) ? value : 0 }))
    },
    onTime: (filename) => {
      if (!playing.has(filename)) return
      const element = audio.current.get(filename)
      setNeedle(mixerPercentFromTime(element?.currentTime ?? 0, element?.duration ?? durations[filename] ?? 0))
    },
    seek,
    setAudio,
    toggleSolo
  }
}

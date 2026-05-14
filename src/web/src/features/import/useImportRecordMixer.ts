import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { isMixerTrackAudible, toggleMixerSolo } from '../../../../shared/import-mixer'

function toggleSet(setter: Dispatch<SetStateAction<Set<string>>>, key: string): void {
  setter((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
}

export type ImportRecordMixerTrack = { filename: string; duration?: number | null }

export function useImportRecordMixer(tracks: ImportRecordMixerTrack[]): {
  duration: number
  muted: Set<string>
  needle: number
  playing: Set<string>
  solo: Set<string>
  isAudible: (filename: string) => boolean
  onEnded: (filename: string) => void
  onLoaded: (filename: string) => void
  onTime: (filename: string) => void
  seek: (time: number) => void
  setAudio: (filename: string, audio: HTMLAudioElement | null) => void
  toggleMute: (filename: string) => void
  togglePlay: (filename: string) => void
  toggleSolo: (filename: string) => void
} {
  const audio = useRef(new Map<string, HTMLAudioElement>())
  const filenames = tracks.map((track) => track.filename)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [muted, setMuted] = useState(new Set<string>())
  const [needle, setNeedle] = useState(0)
  const [playing, setPlaying] = useState(new Set<string>())
  const [solo, setSolo] = useState(new Set<string>())
  const key = filenames.join('\0')
  const duration = Math.max(...tracks.map((track) => durations[track.filename] ?? track.duration ?? 0), 0)
  const isAudible = (filename: string): boolean => isMixerTrackAudible(filename, muted, solo)

  useEffect(() => {
    const keep = new Set(filenames)
    setMuted((current) => new Set([...current].filter((filename) => keep.has(filename))))
    setPlaying((current) => new Set([...current].filter((filename) => keep.has(filename))))
    setSolo((current) => new Set([...current].filter((filename) => keep.has(filename))))
  }, [key])

  useEffect(() => {
    audio.current.forEach((element, filename) => {
      element.muted = !isAudible(filename)
    })
  }, [muted, solo, key])

  const setAudio = (filename: string, element: HTMLAudioElement | null): void => {
    if (element) audio.current.set(filename, element)
    else audio.current.delete(filename)
  }

  const seek = (time: number): void => {
    setNeedle(time)
    audio.current.forEach((element) => {
      element.currentTime = Math.min(time, Number.isFinite(element.duration) ? element.duration : time)
    })
  }

  const togglePlay = (filename: string): void => {
    const element = audio.current.get(filename)
    if (!element) return
    if (playing.has(filename)) {
      element.pause()
      setPlaying((current) => new Set([...current].filter((key) => key !== filename)))
      return
    }
    element.currentTime = Math.min(needle, Number.isFinite(element.duration) ? element.duration : needle)
    element.muted = !isAudible(filename)
    element.play().then(
      () => setPlaying((current) => new Set(current).add(filename)),
      () => setPlaying((current) => new Set([...current].filter((key) => key !== filename)))
    )
  }

  return {
    duration,
    muted,
    needle,
    playing,
    solo,
    isAudible,
    onEnded: (filename) => setPlaying((current) => new Set([...current].filter((key) => key !== filename))),
    onLoaded: (filename) => {
      const value = audio.current.get(filename)?.duration ?? 0
      setDurations((current) => ({ ...current, [filename]: Number.isFinite(value) ? value : 0 }))
    },
    onTime: (filename) => {
      if (!playing.has(filename)) return
      setNeedle(audio.current.get(filename)?.currentTime ?? 0)
    },
    seek,
    setAudio,
    toggleMute: (filename) => toggleSet(setMuted, filename),
    togglePlay,
    toggleSolo: (filename) => setSolo((current) => toggleMixerSolo(current, filename))
  }
}

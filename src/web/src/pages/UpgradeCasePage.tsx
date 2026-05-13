import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link1Icon, LinkBreak2Icon, PauseIcon, PlayIcon } from '@radix-ui/react-icons'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  AudioAnalysis,
  CollectionItem,
  ImportComparison,
  ImportReview,
  UpgradeCandidate,
  UpgradeCandidateSpeedClass,
  UpgradeCase,
  UpgradeCaseStatus,
  UpgradeLocalCandidate
} from '../../../shared/api'
import { api } from '../api/client'
import { ActionButton, LabeledInput, Notice, Pill, ViewSection } from '../components/view'
import { localFileUrl } from '../context/PlayerContext'
import { fileBasename, formatCompactDuration, formatFileSize } from '../lib/music-file'

type SearchDraft = { artist: string; title: string; version: string }
type PlayMode = 'stopped' | 'source' | 'existing' | 'both'

const STATUS_LABEL: Record<UpgradeCaseStatus, string> = {
  idle: 'Idle',
  searching: 'Discogs + Soulseek',
  results_ready: 'Results Ready',
  no_results: 'No Results',
  downloading: 'Downloading Top 4',
  downloaded: 'Candidates Ready',
  pending_reanalyze: 'Pending Rekordbox',
  completed: 'Completed',
  error: 'Error'
}

const STATUS_TONE: Record<UpgradeCaseStatus, 'muted' | 'primary' | 'success' | 'danger'> = {
  idle: 'muted',
  searching: 'primary',
  results_ready: 'primary',
  no_results: 'muted',
  downloading: 'primary',
  downloaded: 'success',
  pending_reanalyze: 'primary',
  completed: 'success',
  error: 'danger'
}

const SPEED_LABEL: Record<UpgradeCandidateSpeedClass, string> = {
  same_track_likely: 'Same Track',
  different_edit_likely: 'Different Edit',
  unknown: 'Unknown'
}

const SPEED_TONE: Record<UpgradeCandidateSpeedClass, 'muted' | 'success' | 'danger'> = {
  same_track_likely: 'success',
  different_edit_likely: 'danger',
  unknown: 'muted'
}

const COMPARISON_KEYS = new Set(['artist', 'title', 'year', 'len'])
const ISSUE_KEYS = new Set(['noise', 'cutoff', 'rumble', 'hum', 'vinyl'])

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected upgrade error'
}

function formatBitrate(value: number | null | undefined): string {
  return value ? `${value} kbps` : '—'
}

function formatDb(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(1) : '—'
}

function formatSignedPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}

function formatHz(value: number | null): string {
  return value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value} Hz`
}

function formatBits(value: number | null): string {
  return !value ? '—' : `${value}-bit`
}

function formatReferenceSource(upgradeCase: UpgradeCase): string {
  if (upgradeCase.referenceDurationSource === 'discogs') return 'Discogs'
  if (upgradeCase.referenceDurationSource === 'current_file') return 'Current File'
  return '—'
}

function buildSearchDraft(upgradeCase: UpgradeCase): SearchDraft {
  return {
    artist: upgradeCase.searchArtist,
    title: upgradeCase.searchTitle,
    version: upgradeCase.searchVersion ?? ''
  }
}

function buildSearchQuery(search: SearchDraft): string {
  return [search.artist, search.title, search.version].filter(Boolean).join(' ')
}

function summarizeMediaType(value: string | null | undefined): string {
  const normalized = value?.toLowerCase() ?? ''
  if (!normalized) return '—'
  if (/\bvinyl|vinilo|12"|10"|7"|45 ?rpm|33 ?rpm\b/.test(normalized)) return 'Vinyl'
  if (/\bcd|cdm|compact disc\b/.test(normalized)) return 'CD'
  if (/\bcassette|tape\b/.test(normalized)) return 'Tape'
  if (/\bfile|digital|web|bandcamp|beatport|traxsource\b/.test(normalized)) return 'WEB'
  return value?.split(' · ')[0] ?? '—'
}

function withVersion(title: string, version?: string | null): string {
  return version ? `${title} (${version})` : title
}

function guessYear(path: string): string {
  return path.match(/(?:^|\/)(19|20)\d{2}(?:\/|$)/)?.[0]?.replaceAll('/', '') ?? '—'
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function qualityIntensity(key: string, analysis: AudioAnalysis | null): number {
  if (COMPARISON_KEYS.has(key) || !analysis) return 0
  const formatScore =
    ({
      wav: 1,
      aiff: 1,
      aif: 1,
      flac: 0.95,
      alac: 0.95,
      m4a: 0.65,
      aac: 0.65,
      ogg: 0.6,
      opus: 0.6,
      mp3: 0.45
    } as Record<string, number>)[analysis.format.toLowerCase()] ?? 0
  if (key === 'format') return clamp01(formatScore)
  if (key === 'bitrate') return clamp01((analysis.bitrateKbps ?? 0) / 320)
  if (key === 'rate') return clamp01((analysis.sampleRateHz ?? 0) / 48000)
  if (key === 'bits') return analysis.bitDepth ? clamp01(analysis.bitDepth / 24) : formatScore
  if (key === 'crest') return clamp01((analysis.crestDb ?? 0) / 16)
  return 0
}

function issueIntensity(key: string, analysis: AudioAnalysis | null): number {
  if (!analysis) return 0
  if (key === 'noise') return clamp01((analysis.noiseScore ?? 0) / 100)
  if (key === 'cutoff') return clamp01(((analysis.cutoffDb ?? 0) - 6) / 18)
  if (key === 'vinyl') return clamp01((analysis.vinylLikelihood ?? 0) / 100)
  return 0
}

function metricBar(key: string, analysis: AudioAnalysis | null): { width: string; className: string } | null {
  if (!analysis || COMPARISON_KEYS.has(key)) return null
  const intensity = ISSUE_KEYS.has(key) ? issueIntensity(key, analysis) : qualityIntensity(key, analysis)
  if (intensity <= 0) return null
  return {
    width: `${Math.round(intensity * 100)}%`,
    className: ISSUE_KEYS.has(key) ? 'bg-rose-500/75' : 'bg-emerald-500/75'
  }
}

function MetricValueCell({
  value,
  bar
}: {
  value: string
  bar: { width: string; className: string } | null
}): React.JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-sm bg-zinc-900/70 px-1.5 py-0.5">
      {bar ? <div className={`absolute inset-y-0 left-0 ${bar.className}`} style={{ width: bar.width }} /> : null}
      <span className="relative z-10">{value}</span>
    </div>
  )
}

function formatOverviewValue(key: string, analysis: AudioAnalysis | null): string {
  if (!analysis) return '—'
  if (key === 'format') return `${analysis.format.toUpperCase()}${analysis.codec ? `/${analysis.codec}` : ''}`
  if (key === 'bitrate') return formatBitrate(analysis.bitrateKbps)
  if (key === 'rate') return formatHz(analysis.sampleRateHz)
  if (key === 'bits') return formatBits(analysis.bitDepth)
  if (key === 'crest') return `${formatDb(analysis.crestDb)} dB`
  if (key === 'noise') return formatPercent(analysis.noiseScore)
  if (key === 'cutoff') return `${formatDb(analysis.cutoffDb)} dB`
  if (key === 'vinyl') return formatPercent(analysis.vinylLikelihood)
  return '—'
}

function classifyLocalFit(
  durationSeconds: number | null,
  referenceDurationSeconds: number | null
): { speedClass: UpgradeCandidateSpeedClass; deltaPercent: number | null } {
  if (durationSeconds == null || referenceDurationSeconds == null || referenceDurationSeconds <= 0) {
    return { speedClass: 'unknown', deltaPercent: null }
  }
  const deltaPercent = ((durationSeconds - referenceDurationSeconds) / referenceDurationSeconds) * 100
  return {
    speedClass: Math.abs(deltaPercent) <= 15 ? 'same_track_likely' : 'different_edit_likely',
    deltaPercent
  }
}

function findRemoteCandidate(
  localCandidate: UpgradeLocalCandidate,
  remoteCandidates: UpgradeCandidate[]
): UpgradeCandidate | null {
  if (localCandidate.source !== 'auto_download') return null
  return (
    remoteCandidates.find(
      (candidate) =>
        candidate.username === localCandidate.sourceUsername &&
        candidate.filename === localCandidate.sourceFilename
    ) ?? null
  )
}

function resolveDiscogsCandidate(
  review: ImportReview | null,
  upgradeCase: UpgradeCase | null
): ImportReview['candidates'][number] | null {
  if (!review?.candidates.length || !upgradeCase) return null
  const searchArtist = normText(upgradeCase.searchArtist)
  const searchTitle = normText(upgradeCase.searchTitle)
  const searchVersion = normText(upgradeCase.searchVersion ?? '')
  return (
    review.candidates.find((candidate) => {
      const sameDuration =
        upgradeCase.officialDurationSeconds == null ||
        candidate.match.durationSeconds == null ||
        Math.abs(candidate.match.durationSeconds - upgradeCase.officialDurationSeconds) < 1
      return (
        sameDuration &&
        normText(candidate.match.artist) === searchArtist &&
        normText(candidate.match.title) === searchTitle &&
        normText(candidate.match.version ?? '') === searchVersion
      )
    }) ??
    (review.selectedCandidateIndex != null ? review.candidates[review.selectedCandidateIndex] ?? null : null) ??
    review.candidates[0] ??
    null
  )
}

function isUsingDiscogsCandidate(
  candidate: ImportReview['candidates'][number] | null,
  upgradeCase: UpgradeCase
): boolean {
  if (!candidate || upgradeCase.referenceDurationSource !== 'discogs') return false
  return (
    candidate.match.durationSeconds != null &&
    upgradeCase.officialDurationSeconds != null &&
    Math.abs(candidate.match.durationSeconds - upgradeCase.officialDurationSeconds) < 1
  )
}

function Table({
  headers,
  children
}: {
  headers: string[]
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/20">
      <table className="w-full min-w-[980px] border-collapse text-left">
        <thead>
          <tr className="bg-zinc-950/50 text-[10px] uppercase tracking-wide text-zinc-500">
            {headers.map((header) => (
              <th key={header} className="px-2 py-1.5 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Overlay({
  title,
  aside,
  onClose,
  children
}: {
  title: string
  aside?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4">
      <div className="mx-auto w-full max-w-6xl rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="text-[13px] font-semibold text-zinc-100">{title}</div>
          <div className="flex flex-wrap gap-2">
            {aside}
            <ActionButton size="xs" onClick={onClose}>
              Close
            </ActionButton>
          </div>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  )
}

export default function UpgradeCasePage(): React.JSX.Element {
  const { upgradeId } = useParams<{ upgradeId: string }>()
  const navigate = useNavigate()
  const [upgradeCase, setUpgradeCase] = useState<UpgradeCase | null>(null)
  const [candidates, setCandidates] = useState<UpgradeCandidate[]>([])
  const [localCandidates, setLocalCandidates] = useState<UpgradeLocalCandidate[]>([])
  const [discogsReview, setDiscogsReview] = useState<ImportReview | null>(null)
  const [importMatches, setImportMatches] = useState<CollectionItem[]>([])
  const [comparisonByFilename, setComparisonByFilename] = useState<Record<string, ImportComparison>>({})
  const [searchDraft, setSearchDraft] = useState<SearchDraft>({ artist: '', title: '', version: '' })
  const [importQuery, setImportQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [discogsError, setDiscogsError] = useState<string | null>(null)
  const [importsError, setImportsError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [showDiscogsMatches, setShowDiscogsMatches] = useState(false)
  const [showSoulseekResearch, setShowSoulseekResearch] = useState(false)
  const [showImportPicker, setShowImportPicker] = useState(false)
  const [crossfade, setCrossfade] = useState(0)
  const [sourceTime, setSourceTime] = useState(0)
  const [existingTime, setExistingTime] = useState(0)
  const [sourceDuration, setSourceDuration] = useState(0)
  const [existingDuration, setExistingDuration] = useState(0)
  const [linkPlayers, setLinkPlayers] = useState(true)
  const [playMode, setPlayMode] = useState<PlayMode>('stopped')
  const initializedCaseIdRef = useRef<number | null>(null)
  const failedComparisonsRef = useRef<Set<string>>(new Set())
  const sourceAudioRef = useRef<HTMLAudioElement>(null)
  const existingAudioRef = useRef<HTMLAudioElement>(null)

  const numericId = Number(upgradeId)
  const pollStatus = upgradeCase?.status ?? null
  const selectedLocal = useMemo(
    () =>
      localCandidates.find((candidate) => candidate.filename === upgradeCase?.selectedLocalFilename) ??
      null,
    [localCandidates, upgradeCase?.selectedLocalFilename]
  )
  const orderedLocalCandidates = useMemo(() => {
    const candidateRank = new Map(
      candidates.map((candidate, index) => [`${candidate.username}:${candidate.filename}`, index])
    )
    return [...localCandidates].sort((left, right) => {
      if (upgradeCase?.selectedLocalFilename === left.filename) return -1
      if (upgradeCase?.selectedLocalFilename === right.filename) return 1
      const leftRemote = findRemoteCandidate(left, candidates)
      const rightRemote = findRemoteCandidate(right, candidates)
      const leftRank =
        leftRemote
          ? candidateRank.get(`${leftRemote.username}:${leftRemote.filename}`) ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER
      const rightRank =
        rightRemote
          ? candidateRank.get(`${rightRemote.username}:${rightRemote.filename}`) ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
      return right.filesize - left.filesize
    })
  }, [candidates, localCandidates, upgradeCase?.selectedLocalFilename])
  const selectedComparison = selectedLocal ? comparisonByFilename[selectedLocal.filename] ?? null : null
  const currentAnalysis = selectedComparison?.existingAnalysis ?? Object.values(comparisonByFilename)[0]?.existingAnalysis ?? null
  const primaryDiscogsCandidate = useMemo(
    () => resolveDiscogsCandidate(discogsReview, upgradeCase),
    [discogsReview, upgradeCase]
  )
  const sourceUrl = selectedLocal ? localFileUrl('', selectedLocal.filename) : ''
  const existingUrl = upgradeCase ? localFileUrl('', upgradeCase.collectionFilename) : ''
  const sourcePlaying = playMode === 'source' || playMode === 'both'
  const existingPlaying = playMode === 'existing' || playMode === 'both'

  const syncDrafts = useCallback((nextCase: UpgradeCase) => {
    const draft = buildSearchDraft(nextCase)
    setSearchDraft(draft)
    setImportQuery(buildSearchQuery(draft))
  }, [])

  const loadCase = useCallback(async (): Promise<void> => {
    const [nextCase, nextCandidates, nextLocalCandidates] = await Promise.all([
      api.upgrades.get(numericId),
      api.upgrades.getCandidates(numericId).catch(() => []),
      api.upgrades.getLocalCandidates(numericId).catch(() => [])
    ])
    if (!nextCase) {
      setUpgradeCase(null)
      setCandidates([])
      setLocalCandidates([])
      setDiscogsReview(null)
      setImportMatches([])
      setComparisonByFilename({})
      setErrorMessage('Upgrade case not found.')
      return
    }

    setUpgradeCase(nextCase)
    setCandidates(nextCandidates)
    setLocalCandidates(nextLocalCandidates)
    if (initializedCaseIdRef.current !== nextCase.id) {
      initializedCaseIdRef.current = nextCase.id
      syncDrafts(nextCase)
      setComparisonByFilename({})
      failedComparisonsRef.current.clear()
    }
    setErrorMessage(null)
  }, [numericId, syncDrafts])

  const loadDiscogsReview = useCallback(async (nextCase: UpgradeCase): Promise<void> => {
    try {
      const review = await api.collection.getImportReview(
        nextCase.collectionFilename,
        {
          artist: nextCase.searchArtist,
          title: nextCase.searchTitle,
          version: nextCase.searchVersion ?? undefined
        },
        true
      )
      setDiscogsReview(review)
      setDiscogsError(null)
    } catch (error) {
      setDiscogsReview(null)
      setDiscogsError(formatError(error))
    }
  }, [])

  const loadImportMatches = useCallback(async (query: string): Promise<void> => {
    try {
      const result = await api.collection.listDownloads(query)
      setImportMatches(result.items)
      setImportsError(null)
    } catch (error) {
      setImportMatches([])
      setImportsError(formatError(error))
    }
  }, [])

  useEffect(() => {
    if (!Number.isFinite(numericId) || numericId <= 0) {
      setErrorMessage('Upgrade case id is invalid.')
      setIsLoading(false)
      return
    }
    let active = true
    void (async () => {
      try {
        await loadCase()
      } catch (error) {
        if (active) setErrorMessage(formatError(error))
      } finally {
        if (active) setIsLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [loadCase, numericId])

  useEffect(() => {
    if (!upgradeCase) return
    void loadDiscogsReview(upgradeCase)
    void loadImportMatches(buildSearchQuery(buildSearchDraft(upgradeCase)))
  }, [loadDiscogsReview, loadImportMatches, upgradeCase])

  useEffect(() => {
    if (!upgradeCase || orderedLocalCandidates.length === 0) return
    const missing = orderedLocalCandidates.filter(
      (candidate) =>
        !comparisonByFilename[candidate.filename] &&
        !failedComparisonsRef.current.has(candidate.filename)
    )
    if (missing.length === 0) return

    let active = true
    void Promise.allSettled(
      missing.map(async (candidate) => ({
        filename: candidate.filename,
        comparison: await api.collection.compareImport(candidate.filename, upgradeCase.collectionFilename)
      }))
    ).then((results) => {
      if (!active) return
      const next: Record<string, ImportComparison> = {}
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          next[result.value.filename] = result.value.comparison
        } else {
          const failedFilename = missing[index]?.filename
          if (failedFilename) failedComparisonsRef.current.add(failedFilename)
        }
      }
      if (Object.keys(next).length > 0) {
        setComparisonByFilename((current) => ({ ...current, ...next }))
      }
    })

    return () => {
      active = false
    }
  }, [comparisonByFilename, orderedLocalCandidates, upgradeCase])

  useEffect(() => {
    if (!['searching', 'downloading'].includes(pollStatus ?? '')) return
    const poll = window.setInterval(() => {
      void loadCase()
    }, 2000)
    return () => window.clearInterval(poll)
  }, [loadCase, pollStatus])

  useEffect(() => {
    const source = sourceAudioRef.current
    const existing = existingAudioRef.current
    if (!selectedLocal || !source) return
    source.volume = (100 - crossfade) / 100
    if (existing) existing.volume = crossfade / 100
  }, [crossfade, selectedLocal])

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
  }, [selectedLocal?.filename, upgradeCase?.collectionFilename])

  useEffect(() => {
    const sourceAudio = sourceAudioRef.current
    const existingAudio = existingAudioRef.current
    return () => {
      sourceAudio?.pause()
      existingAudio?.pause()
    }
  }, [])

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
    if (linkPlayers && existingAudioRef.current) {
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
    if (!existing) return
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

  async function rerunSoulseekSearch(): Promise<void> {
    setBusyAction('search')
    try {
      const nextCase = await api.upgrades.search(numericId, {
        artist: searchDraft.artist,
        title: searchDraft.title,
        version: searchDraft.version || null
      })
      if (nextCase) {
        setUpgradeCase(nextCase)
        syncDrafts(nextCase)
      }
      setCandidates([])
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function refreshDiscogs(): Promise<void> {
    if (!upgradeCase) return
    setBusyAction('discogs')
    try {
      await loadDiscogsReview({
        ...upgradeCase,
        searchArtist: searchDraft.artist,
        searchTitle: searchDraft.title,
        searchVersion: searchDraft.version || null
      })
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  function resetDiscogsSearch(): void {
    if (!upgradeCase) return
    setSearchDraft(buildSearchDraft(upgradeCase))
    void loadDiscogsReview(upgradeCase)
  }

  async function applyDiscogsCandidate(candidate: ImportReview['candidates'][number]): Promise<void> {
    const key = `reference:${candidate.match.releaseId}:${candidate.match.trackPosition ?? 'na'}`
    setBusyAction(key)
    try {
      const nextCase = await api.upgrades.setReference(numericId, {
        artist: candidate.match.artist,
        title: candidate.match.title,
        version: candidate.match.version,
        durationSeconds: candidate.match.durationSeconds ?? null
      })
      if (nextCase) {
        setUpgradeCase(nextCase)
        syncDrafts(nextCase)
      }
      setCandidates([])
      setShowDiscogsMatches(false)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function downloadRemoteCandidate(candidate: UpgradeCandidate): Promise<void> {
    const key = `download:${candidate.username}:${candidate.filename}`
    setBusyAction(key)
    try {
      await api.upgrades.download(numericId, candidate.username, candidate.filename, candidate.size)
      await loadCase()
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function addImportCandidate(item: CollectionItem): Promise<void> {
    const key = `add:${item.filename}`
    setBusyAction(key)
    try {
      const nextCase = await api.upgrades.addLocalCandidate(numericId, item.filename)
      if (nextCase) setUpgradeCase(nextCase)
      await loadCase()
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function selectLocalCandidate(filename: string): Promise<void> {
    const key = `select:${filename}`
    setBusyAction(key)
    try {
      const nextCase = await api.upgrades.selectLocalCandidate(numericId, filename)
      if (nextCase) setUpgradeCase(nextCase)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function replaceCurrent(): Promise<void> {
    setBusyAction('replace')
    try {
      const nextCase = await api.upgrades.replace(numericId)
      if (nextCase) setUpgradeCase(nextCase)
      await loadCase()
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function markReanalyzed(): Promise<void> {
    setBusyAction('reanalyze')
    try {
      const nextCase = await api.upgrades.markReanalyzed(numericId)
      if (nextCase) setUpgradeCase(nextCase)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction(null)
    }
  }

  if (isLoading) {
    return <Notice>Loading upgrade case…</Notice>
  }

  if (errorMessage && !upgradeCase) {
    return (
      <div className="space-y-4">
        <ActionButton size="xs" onClick={() => navigate('/upgrades')}>
          Back
        </ActionButton>
        <Notice tone="error">{errorMessage}</Notice>
      </div>
    )
  }

  if (!upgradeCase) {
    return (
      <div className="space-y-4">
        <ActionButton size="xs" onClick={() => navigate('/upgrades')}>
          Back
        </ActionButton>
        <Notice tone="error">Upgrade case not found.</Notice>
      </div>
    )
  }

  const collectionYear = guessYear(upgradeCase.collectionFilename)
  const currentFit = classifyLocalFit(
    currentAnalysis?.durationSeconds ?? upgradeCase.currentDurationSeconds,
    upgradeCase.referenceDurationSeconds
  )

  return (
    <div className="space-y-3">
      <audio
        ref={sourceAudioRef}
        src={sourceUrl}
        preload="metadata"
        onLoadedMetadata={() => {
          const nextDuration = sourceAudioRef.current?.duration ?? 0
          setSourceDuration(isFinite(nextDuration) ? nextDuration : 0)
        }}
        onTimeUpdate={() => {
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
        }}
        onEnded={pausePlayback}
      />
      <audio
        ref={existingAudioRef}
        src={existingUrl}
        preload="metadata"
        onLoadedMetadata={() => {
          const nextDuration = existingAudioRef.current?.duration ?? 0
          setExistingDuration(isFinite(nextDuration) ? nextDuration : 0)
        }}
        onTimeUpdate={() => {
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
        }}
        onEnded={pausePlayback}
      />

      <ViewSection
        padding="sm"
        title={
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate">{fileBasename(upgradeCase.collectionFilename)}</span>
            {collectionYear !== '—' ? <Pill>{collectionYear}</Pill> : null}
            <Pill tone={STATUS_TONE[upgradeCase.status]}>{STATUS_LABEL[upgradeCase.status]}</Pill>
          </div>
        }
        subtitle={
          <span>
            Ideal {formatCompactDuration(upgradeCase.referenceDurationSeconds)} · {formatReferenceSource(upgradeCase)} ·{' '}
            {upgradeCase.localCandidateCount} downloads · {upgradeCase.candidateCount} soulseek hits
          </span>
        }
        aside={
          <div className="flex flex-wrap gap-2">
            <ActionButton size="xs" onClick={() => navigate('/upgrades')}>
              Back
            </ActionButton>
            <ActionButton size="xs" onClick={() => setShowDiscogsMatches(true)}>
              Change Discogs Match
            </ActionButton>
            <ActionButton size="xs" onClick={() => setShowSoulseekResearch(true)}>
              Search Soulseek
            </ActionButton>
            <ActionButton size="xs" onClick={() => setShowImportPicker(true)}>
              Search Imports
            </ActionButton>
          </div>
        }
      >
        {errorMessage || upgradeCase.lastError ? (
          <Notice tone="error" className="mt-2">
            {errorMessage ?? upgradeCase.lastError}
          </Notice>
        ) : null}
      </ViewSection>

      <ViewSection
        padding="sm"
        title={selectedLocal ? fileBasename(selectedLocal.filename) : 'Double Player'}
        subtitle={selectedLocal ? selectedLocal.filename : 'Select a candidate from the table below.'}
        aside={
          <div className="flex flex-wrap gap-2">
            {selectedLocal ? (
              <>
                <ActionButton size="xs" onClick={() => void api.collection.showInFinder(selectedLocal.filename)}>
                  Reveal Candidate
                </ActionButton>
                <ActionButton size="xs" onClick={() => void api.collection.showInFinder(upgradeCase.collectionFilename)}>
                  Reveal Current
                </ActionButton>
                <ActionButton size="xs" tone="danger" disabled={busyAction === 'replace'} onClick={() => void replaceCurrent()}>
                  {busyAction === 'replace' ? 'Replacing…' : 'Replace Current'}
                </ActionButton>
              </>
            ) : null}
            {upgradeCase.status === 'pending_reanalyze' ? (
              <ActionButton size="xs" tone="success" disabled={busyAction === 'reanalyze'} onClick={() => void markReanalyzed()}>
                {busyAction === 'reanalyze' ? 'Saving…' : 'Mark Rekordbox Reanalyzed'}
              </ActionButton>
            ) : null}
          </div>
        }
      >
        {!selectedLocal ? (
          <Notice>Select a candidate first.</Notice>
        ) : (
          <div className="grid gap-2 border-b border-zinc-800 pb-2 md:grid-cols-[1fr,140px,1fr]">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Candidate</div>
                <div className="text-[10px] text-zinc-500">
                  {formatCompactDuration(sourceTime)} / {formatCompactDuration(sourceDuration || selectedComparison?.sourceAnalysis?.durationSeconds || selectedLocal.durationSeconds)}
                </div>
              </div>
              <ActionButton
                size="xs"
                tone={sourcePlaying ? 'primary' : 'default'}
                onClick={sourcePlaying ? pausePlayback : playSource}
                aria-label={sourcePlaying ? 'Pause candidate' : 'Play candidate'}
              >
                {sourcePlaying ? <PauseIcon /> : <PlayIcon />}
              </ActionButton>
              <input
                type="range"
                min={0}
                max={Math.max(sourceDuration || selectedComparison?.sourceAnalysis?.durationSeconds || 0, 0)}
                step={0.1}
                value={Math.min(sourceTime, Math.max(sourceDuration || selectedComparison?.sourceAnalysis?.durationSeconds || 0, 0))}
                onChange={(event) => syncSourceTime(Number(event.target.value))}
                className="w-full"
              />
            </div>
            <div className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-zinc-800/70 px-2 py-1">
              <ActionButton
                size="xs"
                tone={linkPlayers ? 'primary' : 'default'}
                onClick={() => setLinkPlayers((value) => !value)}
                aria-label={linkPlayers ? 'Unlink players' : 'Link players'}
              >
                {linkPlayers ? <Link1Icon /> : <LinkBreak2Icon />}
              </ActionButton>
              <div className="flex w-full items-center gap-1 text-[9px] text-zinc-500">
                <span>N</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={crossfade}
                  onChange={(event) => setCrossfade(Number(event.target.value))}
                  className="w-full"
                />
                <span>E</span>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Current</div>
                <div className="text-[10px] text-zinc-500">
                  {formatCompactDuration(existingTime)} / {formatCompactDuration(existingDuration || currentAnalysis?.durationSeconds || upgradeCase.currentDurationSeconds)}
                </div>
              </div>
              <ActionButton
                size="xs"
                tone={existingPlaying ? 'primary' : 'default'}
                onClick={existingPlaying ? pausePlayback : playExisting}
                aria-label={existingPlaying ? 'Pause current' : 'Play current'}
              >
                {existingPlaying ? <PauseIcon /> : <PlayIcon />}
              </ActionButton>
              <input
                type="range"
                min={0}
                max={Math.max(existingDuration || currentAnalysis?.durationSeconds || 0, 0)}
                step={0.1}
                value={Math.min(existingTime, Math.max(existingDuration || currentAnalysis?.durationSeconds || 0, 0))}
                onChange={(event) => syncExistingTime(Number(event.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}
      </ViewSection>

      <ViewSection padding="sm">
        {!orderedLocalCandidates.length ? (
          <Notice>
            {upgradeCase.status === 'downloading'
              ? 'Waiting for Soulseek downloads…'
              : 'No downloaded candidates yet. Use Search Soulseek or Search Imports.'}
          </Notice>
        ) : (
          <Table headers={['Source', 'Len', 'Delta', 'Format', 'Bitrate', 'Rate', 'Bits', 'Crest', 'Noise', 'Cutoff', 'Vinyl', '']}>
            {primaryDiscogsCandidate ? (
              <tr className="border-t border-zinc-800 bg-zinc-900/30 text-[11px] text-zinc-200">
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Pill tone="primary">Discogs</Pill>
                    <span className="truncate">{withVersion(primaryDiscogsCandidate.match.title, primaryDiscogsCandidate.match.version)}</span>
                  </div>
                  <div className="truncate text-zinc-500" title={primaryDiscogsCandidate.match.releaseTitle}>
                    {primaryDiscogsCandidate.match.releaseTitle}
                  </div>
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">{formatCompactDuration(primaryDiscogsCandidate.match.durationSeconds ?? null)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap text-zinc-500">Ideal</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{summarizeMediaType(primaryDiscogsCandidate.match.format)}</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 text-zinc-500">—</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {isUsingDiscogsCandidate(primaryDiscogsCandidate, upgradeCase) ? <Pill tone="primary">Using</Pill> : null}
                </td>
              </tr>
            ) : null}

            <tr className="border-t border-zinc-800 text-[11px] text-zinc-300">
              <td className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <Pill>Current</Pill>
                  <span className="truncate">{fileBasename(upgradeCase.collectionFilename)}</span>
                </div>
                <div className="truncate text-zinc-500">{upgradeCase.collectionFilename}</div>
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">{formatCompactDuration(currentAnalysis?.durationSeconds ?? upgradeCase.currentDurationSeconds)}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <Pill tone={SPEED_TONE[currentFit.speedClass]}>{formatSignedPercent(currentFit.deltaPercent)}</Pill>
              </td>
              {(['format', 'bitrate', 'rate', 'bits', 'crest', 'noise', 'cutoff', 'vinyl'] as const).map((key) => (
                <td key={key} className="px-2 py-1.5 whitespace-nowrap">
                  <MetricValueCell value={formatOverviewValue(key, currentAnalysis)} bar={metricBar(key, currentAnalysis)} />
                </td>
              ))}
              <td className="px-2 py-1.5 whitespace-nowrap">
                <ActionButton size="xs" onClick={() => void api.collection.showInFinder(upgradeCase.collectionFilename)}>
                  Reveal
                </ActionButton>
              </td>
            </tr>

            {orderedLocalCandidates.map((candidate) => {
              const remoteCandidate = findRemoteCandidate(candidate, candidates)
              const fit = remoteCandidate
                ? { speedClass: remoteCandidate.speedClass, deltaPercent: remoteCandidate.durationDeltaPercent }
                : classifyLocalFit(candidate.durationSeconds, upgradeCase.referenceDurationSeconds)
              const analysis = comparisonByFilename[candidate.filename]?.sourceAnalysis ?? null
              const isSelected = upgradeCase.selectedLocalFilename === candidate.filename

              return (
                <tr key={candidate.filename} className={`border-t border-zinc-800 text-[11px] text-zinc-200 ${isSelected ? 'bg-amber-950/20' : ''}`}>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <Pill tone={SPEED_TONE[fit.speedClass]}>{SPEED_LABEL[fit.speedClass]}</Pill>
                      {isSelected ? <Pill tone="primary">Selected</Pill> : null}
                      <span className="truncate">{fileBasename(candidate.filename)}</span>
                    </div>
                    <div className="truncate text-zinc-500">
                      {candidate.source === 'auto_download' ? candidate.sourceUsername ?? 'Soulseek' : 'Import folder'} · {formatFileSize(candidate.filesize)}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{formatCompactDuration(candidate.durationSeconds)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <Pill tone={SPEED_TONE[fit.speedClass]}>{formatSignedPercent(fit.deltaPercent)}</Pill>
                  </td>
                  {(['format', 'bitrate', 'rate', 'bits', 'crest', 'noise', 'cutoff', 'vinyl'] as const).map((key) => (
                    <td key={key} className="px-2 py-1.5 whitespace-nowrap">
                      <MetricValueCell value={formatOverviewValue(key, analysis)} bar={metricBar(key, analysis)} />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className="flex gap-2">
                      <ActionButton size="xs" tone={isSelected ? 'primary' : 'default'} disabled={busyAction === `select:${candidate.filename}`} onClick={() => void selectLocalCandidate(candidate.filename)}>
                        {isSelected ? 'Using' : 'Use'}
                      </ActionButton>
                      <ActionButton size="xs" onClick={() => void api.collection.showInFinder(candidate.filename)}>
                        Reveal
                      </ActionButton>
                    </div>
                  </td>
                </tr>
              )
            })}
          </Table>
        )}
      </ViewSection>

      {showDiscogsMatches ? (
        <Overlay
          title="Search Discogs Match"
          onClose={() => setShowDiscogsMatches(false)}
        >
          <form
            className="grid gap-3 md:grid-cols-[1fr,1fr,0.8fr,auto,auto]"
            onSubmit={(event) => {
              event.preventDefault()
              void refreshDiscogs()
            }}
          >
            <LabeledInput
              label="Artist"
              value={searchDraft.artist}
              onChange={(event) => setSearchDraft((value) => ({ ...value, artist: event.target.value }))}
            />
            <LabeledInput
              label="Title"
              value={searchDraft.title}
              onChange={(event) => setSearchDraft((value) => ({ ...value, title: event.target.value }))}
            />
            <LabeledInput
              label="Version"
              value={searchDraft.version}
              onChange={(event) => setSearchDraft((value) => ({ ...value, version: event.target.value }))}
            />
            <div className="flex items-end">
              <ActionButton size="xs" type="submit" disabled={busyAction === 'discogs'}>
                {busyAction === 'discogs' ? 'Searching…' : 'Search Discogs'}
              </ActionButton>
            </div>
            <div className="flex items-end">
              <ActionButton size="xs" type="button" disabled={busyAction === 'discogs'} onClick={resetDiscogsSearch}>
                Reset
              </ActionButton>
            </div>
          </form>
          {primaryDiscogsCandidate ? (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px] text-zinc-300">
              <div className="flex items-center gap-2">
                <Pill tone="primary">Current Match</Pill>
                <span>
                  {primaryDiscogsCandidate.match.artist} - {withVersion(primaryDiscogsCandidate.match.title, primaryDiscogsCandidate.match.version)}
                </span>
              </div>
              <div className="mt-1 text-zinc-500">
                {primaryDiscogsCandidate.match.releaseTitle} · {formatCompactDuration(primaryDiscogsCandidate.match.durationSeconds ?? null)}
              </div>
            </div>
          ) : null}
          {discogsError ? <Notice tone="error" className="mt-3">{discogsError}</Notice> : null}
          <div className="mt-3">
            <Table headers={['Track', 'Release', 'Len', 'Meta', '']}>
              {discogsReview?.candidates.map((candidate) => (
                <tr
                  key={`${candidate.match.releaseId}:${candidate.match.trackPosition ?? 'na'}`}
                  className={`border-t border-zinc-800 text-[11px] text-zinc-200 ${
                    isUsingDiscogsCandidate(candidate, upgradeCase) ? 'bg-amber-950/20' : ''
                  }`}
                >
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      {isUsingDiscogsCandidate(candidate, upgradeCase) ? <Pill tone="primary">Using</Pill> : null}
                      <span>{candidate.match.artist} - {withVersion(candidate.match.title, candidate.match.version)}</span>
                    </div>
                    <div className="text-zinc-500">{candidate.match.trackPosition ?? '—'}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div>{candidate.match.releaseTitle}</div>
                    <div className="text-zinc-500">{candidate.match.label ?? '—'} · {candidate.match.year ?? '—'}</div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{formatCompactDuration(candidate.match.durationSeconds ?? null)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-zinc-500">
                    {summarizeMediaType(candidate.match.format)} · score {candidate.match.score}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <ActionButton
                      size="xs"
                      disabled={busyAction === `reference:${candidate.match.releaseId}:${candidate.match.trackPosition ?? 'na'}`}
                      onClick={() => void applyDiscogsCandidate(candidate)}
                    >
                      {isUsingDiscogsCandidate(candidate, upgradeCase) ? 'Using' : 'Use Match'}
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </Overlay>
      ) : null}

      {showSoulseekResearch ? (
        <Overlay
          title="Soulseek Search"
          onClose={() => setShowSoulseekResearch(false)}
          aside={
            <ActionButton size="xs" disabled={busyAction === 'search'} onClick={() => void rerunSoulseekSearch()}>
              {busyAction === 'search' ? 'Searching…' : 'Search Again'}
            </ActionButton>
          }
        >
          <div className="grid gap-3 md:grid-cols-3">
            <LabeledInput label="Artist" value={searchDraft.artist} onChange={(event) => setSearchDraft((value) => ({ ...value, artist: event.target.value }))} />
            <LabeledInput label="Title" value={searchDraft.title} onChange={(event) => setSearchDraft((value) => ({ ...value, title: event.target.value }))} />
            <LabeledInput label="Version" value={searchDraft.version} onChange={(event) => setSearchDraft((value) => ({ ...value, version: event.target.value }))} />
          </div>
          <div className="mt-3">
            <Table headers={['Fit', 'File', 'User', 'Queue', '']}>
              {candidates.map((candidate, index) => (
                <tr key={`${candidate.username}:${candidate.filename}:${candidate.size}`} className="border-t border-zinc-800 text-[11px] text-zinc-200">
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Pill tone={SPEED_TONE[candidate.speedClass]}>{SPEED_LABEL[candidate.speedClass]}</Pill>
                      {index < 4 && !candidate.isLocked ? <Pill tone="primary">Auto</Pill> : null}
                    </div>
                    <div className="text-zinc-500">
                      {formatCompactDuration(candidate.durationSeconds)} · {formatSignedPercent(candidate.durationDeltaPercent)}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="truncate" title={candidate.filename}>{fileBasename(candidate.filename)}</div>
                    <div className="text-zinc-500">
                      {candidate.extension.toUpperCase()} · {formatBitrate(candidate.bitrate)} · {formatFileSize(candidate.size)}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{candidate.username}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-zinc-500">
                    Q {candidate.queueLength ?? '—'} · {candidate.isLocked ? 'Locked' : 'Open'}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <ActionButton
                      size="xs"
                      disabled={candidate.isLocked || busyAction === `download:${candidate.username}:${candidate.filename}`}
                      onClick={() => void downloadRemoteCandidate(candidate)}
                    >
                      {candidate.isLocked
                        ? 'Locked'
                        : busyAction === `download:${candidate.username}:${candidate.filename}`
                          ? 'Queueing…'
                          : 'Download'}
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </Overlay>
      ) : null}

      {showImportPicker ? (
        <Overlay
          title="Import Candidates"
          onClose={() => setShowImportPicker(false)}
          aside={
            <ActionButton
              size="xs"
              disabled={busyAction === 'imports-refresh'}
              onClick={() => {
                void (async () => {
                  setBusyAction('imports-refresh')
                  try {
                    await loadImportMatches(importQuery)
                    setErrorMessage(null)
                  } catch (error) {
                    setErrorMessage(formatError(error))
                  } finally {
                    setBusyAction(null)
                  }
                })()
              }}
            >
              {busyAction === 'imports-refresh' ? 'Searching…' : 'Search'}
            </ActionButton>
          }
        >
          <div className="max-w-xl">
            <LabeledInput label="Import Search" value={importQuery} onChange={(event) => setImportQuery(event.target.value)} />
          </div>
          {importsError ? <Notice tone="error" className="mt-3">{importsError}</Notice> : null}
          <div className="mt-3">
            <Table headers={['File', 'Size', '']}>
              {importMatches.map((item) => (
                <tr key={item.filename} className="border-t border-zinc-800 text-[11px] text-zinc-200">
                  <td className="px-2 py-1.5">
                    <div className="truncate" title={item.filename}>{fileBasename(item.filename)}</div>
                    <div className="truncate text-zinc-500">{item.filename}</div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-zinc-500">
                    {item.duration != null ? `${formatCompactDuration(item.duration)} · ` : ''}
                    {formatFileSize(item.filesize)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className="flex gap-2">
                      <ActionButton size="xs" disabled={busyAction === `add:${item.filename}`} onClick={() => void addImportCandidate(item)}>
                        Add
                      </ActionButton>
                      <ActionButton size="xs" onClick={() => void api.collection.showInFinder(item.filename)}>
                        Reveal
                      </ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </Overlay>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollectionItem, CollectionItemDetails, DownloadAttempt, SlskdCandidate, WantListItem } from '@djbrain/shared/api'
import type { OnlineSearchItem } from '@djbrain/shared/online-search'
import { shouldPollWantListItem } from '@djbrain/shared/want-list-polling'
import { api } from '../../api/client'
import { extractYouTubeId } from '../../lib/youtube'
import {
  buildSavedResearchQuery,
  formatWantListError,
  toWantListAddInput,
  toWantListEditState,
  type WantListEditState
} from './view-model'

export type WantListVideoResult = {
  id: string
  title: string
  link: string
  source: string
}

export type WantListLocalResult = CollectionItem & {
  source: 'song' | 'download'
}

type SectionErrors = {
  soulseek: string | null
  youtube: string | null
  collection: string | null
}

function mergeLocalResults(
  songs: CollectionItem[],
  downloads: CollectionItem[]
): WantListLocalResult[] {
  const byFilename = new Map<string, WantListLocalResult>()

  for (const item of songs) {
    byFilename.set(item.filename, { ...item, source: 'song' })
  }

  for (const item of downloads) {
    byFilename.set(item.filename, { ...item, source: 'download' })
  }

  return [...byFilename.values()]
    .sort(
      (left, right) =>
        (right.score ?? -1) - (left.score ?? -1) ||
        left.filename.localeCompare(right.filename, undefined, { sensitivity: 'base' })
    )
    .slice(0, 10)
}

function extractVideoResults(items: OnlineSearchItem[]): WantListVideoResult[] {
  const seen = new Set<string>()
  const videos: WantListVideoResult[] = []

  for (const item of items) {
    if (item.source !== 'youtube') {
      continue
    }

    const id = extractYouTubeId(item.link)
    if (!id || seen.has(id)) {
      continue
    }

    seen.add(id)
    videos.push({
      id,
      title: item.title,
      link: item.link,
      source: 'Search'
    })
  }

  return videos
}

export function useWantListItemPage(wantId: string | undefined) {
  const numericId = Number(wantId)
  const [item, setItem] = useState<WantListItem | null>(null)
  const [editState, setEditState] = useState<WantListEditState | null>(null)
  const [soulseekQuery, setSoulseekQuery] = useState('')
  const [youtubeQuery, setYoutubeQuery] = useState('')
  const [collectionQuery, setCollectionQuery] = useState('')
  const [soulseekResults, setSoulseekResults] = useState<SlskdCandidate[]>([])
  const [downloadAttempts, setDownloadAttempts] = useState<DownloadAttempt[]>([])
  const [sourceItem, setSourceItem] = useState<CollectionItemDetails | null>(null)
  const [youtubeResults, setYoutubeResults] = useState<WantListVideoResult[]>([])
  const [collectionResults, setCollectionResults] = useState<WantListLocalResult[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoadingSoulseek, setIsLoadingSoulseek] = useState(false)
  const [isLoadingSourceItem, setIsLoadingSourceItem] = useState(false)
  const [isLoadingYouTube, setIsLoadingYouTube] = useState(false)
  const [isLoadingCollection, setIsLoadingCollection] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [sourceItemError, setSourceItemError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({
    soulseek: null,
    youtube: null,
    collection: null
  })

  const itemRequestRef = useRef(0)
  const youtubeRequestRef = useRef(0)
  const collectionRequestRef = useRef(0)
  const sourceItemRequestRef = useRef(0)

  const loadDownloadAttempts = useCallback(async (id: number): Promise<void> => {
    setDownloadAttempts(await api.wantList.listDownloads(id))
  }, [])

  const loadSoulseekResults = useCallback(async (id: number): Promise<void> => {
    setSectionErrors((current) => ({ ...current, soulseek: null }))
    const results = await api.wantList.getCandidates(id)
    setSoulseekResults(results)
  }, [])

  const loadYouTubeResults = useCallback(async (query: string, fallbackItem?: WantListItem | null): Promise<void> => {
    const effectiveQuery = query.trim() || (fallbackItem ? buildSavedResearchQuery(fallbackItem) : '')
    const requestId = youtubeRequestRef.current + 1
    youtubeRequestRef.current = requestId
    setIsLoadingYouTube(true)
    setSectionErrors((current) => ({ ...current, youtube: null }))

    try {
      const response = await api.youtube.search(effectiveQuery)
      if (youtubeRequestRef.current !== requestId) {
        return
      }
      setYoutubeResults(extractVideoResults(response.items))
    } catch (error) {
      if (youtubeRequestRef.current !== requestId) {
        return
      }
      setYoutubeResults([])
      setSectionErrors((current) => ({
        ...current,
        youtube: formatWantListError(error, 'Failed to load YouTube videos')
      }))
    } finally {
      if (youtubeRequestRef.current === requestId) {
        setIsLoadingYouTube(false)
      }
    }
  }, [])

  const loadCollectionResults = useCallback(async (query: string, fallbackItem?: WantListItem | null): Promise<void> => {
    const effectiveQuery = query.trim() || (fallbackItem ? buildSavedResearchQuery(fallbackItem) : '')
    const requestId = collectionRequestRef.current + 1
    collectionRequestRef.current = requestId
    setIsLoadingCollection(true)
    setSectionErrors((current) => ({ ...current, collection: null }))

    try {
      const [songs, downloads] = await Promise.all([
        api.collection.list(effectiveQuery),
        api.collection.listDownloads(effectiveQuery)
      ])

      if (collectionRequestRef.current !== requestId) {
        return
      }

      setCollectionResults(mergeLocalResults(songs.items, downloads.items))
    } catch (error) {
      if (collectionRequestRef.current !== requestId) {
        return
      }
      setCollectionResults([])
      setSectionErrors((current) => ({
        ...current,
        collection: formatWantListError(error, 'Failed to load collection results')
      }))
    } finally {
      if (collectionRequestRef.current === requestId) {
        setIsLoadingCollection(false)
      }
    }
  }, [])

  useEffect(() => {
    const sourceFilename = item?.wantKind === 'replacement' ? item.sourceCollectionFilename : null
    const requestId = sourceItemRequestRef.current + 1
    sourceItemRequestRef.current = requestId

    if (!sourceFilename) {
      setSourceItem(null)
      setSourceItemError(null)
      setIsLoadingSourceItem(false)
      return
    }

    setIsLoadingSourceItem(true)
    setSourceItem(null)
    setSourceItemError(null)
    void api.collection.get(sourceFilename)
      .then((next) => {
        if (sourceItemRequestRef.current === requestId) setSourceItem(next)
      })
      .catch((error) => {
        if (sourceItemRequestRef.current !== requestId) return
        setSourceItem(null)
        setSourceItemError(formatWantListError(error, 'Failed to load linked source record'))
      })
      .finally(() => {
        if (sourceItemRequestRef.current === requestId) setIsLoadingSourceItem(false)
      })
  }, [item?.sourceCollectionFilename, item?.wantKind])

  useEffect(() => {
    if (!Number.isInteger(numericId) || numericId <= 0) {
      setItem(null)
      setEditState(null)
      setErrorMessage('Want list item id is invalid.')
      setIsLoading(false)
      return
    }

    const requestId = itemRequestRef.current + 1
    itemRequestRef.current = requestId
    setIsLoading(true)
    setErrorMessage(null)

    void (async () => {
      try {
        const nextItem = await api.wantList.get(numericId)
        if (itemRequestRef.current !== requestId) {
          return
        }
        if (!nextItem) {
          setItem(null)
          setEditState(null)
          setErrorMessage('Want list item not found.')
          return
        }

        const defaultQuery = buildSavedResearchQuery(nextItem)
        setItem(nextItem)
        setEditState(toWantListEditState(nextItem))
        setSoulseekQuery(defaultQuery)
        setYoutubeQuery(defaultQuery)
        setCollectionQuery(defaultQuery)

        await Promise.all([
          loadSoulseekResults(nextItem.id),
          loadDownloadAttempts(nextItem.id),
          loadYouTubeResults(defaultQuery, nextItem),
          loadCollectionResults(defaultQuery, nextItem)
        ])
      } catch (error) {
        if (itemRequestRef.current !== requestId) {
          return
        }
        setItem(null)
        setEditState(null)
        setErrorMessage(formatWantListError(error))
      } finally {
        if (itemRequestRef.current === requestId) {
          setIsLoading(false)
        }
      }
    })()
  }, [loadCollectionResults, loadDownloadAttempts, loadSoulseekResults, loadYouTubeResults, numericId])

  useEffect(() => {
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return
    }

    return api.wantList.onItemUpdated((updated) => {
      if (updated.id !== numericId) {
        return
      }

      setItem(updated)

      if (
        updated.pipelineStatus === 'results_ready' ||
        updated.pipelineStatus === 'no_results' ||
        updated.pipelineStatus === 'error'
      ) {
        setIsLoadingSoulseek(false)
        void loadSoulseekResults(updated.id).catch((error) => {
          setSectionErrors((current) => ({
            ...current,
            soulseek: formatWantListError(error, 'Failed to load Soulseek results')
          }))
        })
      }
      if (['queued', 'downloading', 'downloaded', 'error'].includes(updated.pipelineStatus)) {
        void loadDownloadAttempts(updated.id).catch((error) => setActionError(formatWantListError(error)))
      }
    })
  }, [loadDownloadAttempts, loadSoulseekResults, numericId])

  useEffect(() => {
    if (!item || !shouldPollWantListItem(item.pipelineStatus)) return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const updated = await api.wantList.get(item.id)
          if (updated) {
            setItem(updated)
            if (updated.searchId !== item.searchId || updated.searchResultCount !== item.searchResultCount) {
              await loadSoulseekResults(updated.id)
            }
          }
          await loadDownloadAttempts(item.id)
        } catch (error) {
          setActionError(formatWantListError(error, 'Failed to refresh downloader state'))
        }
      })()
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [item, loadDownloadAttempts, loadSoulseekResults])

  const save = useCallback(async (): Promise<void> => {
    if (!item || !editState) {
      return
    }

    setIsSaving(true)
    setActionError(null)
    try {
      const updated = await api.wantList.update(item.id, toWantListAddInput(editState))
      if (!updated) {
        throw new Error('Want list item not found.')
      }
      setItem(updated)
      setEditState(toWantListEditState(updated))
    } catch (error) {
      setActionError(formatWantListError(error))
    } finally {
      setIsSaving(false)
    }
  }, [editState, item])

  const searchSoulseek = useCallback(async (): Promise<void> => {
    if (!item) {
      return
    }

    setIsLoadingSoulseek(true)
    setActionError(null)
    setSectionErrors((current) => ({ ...current, soulseek: null }))

    try {
      const updated = await api.wantList.search(item.id, soulseekQuery)
      if (updated) {
        setItem(updated)
      }

      await loadSoulseekResults(item.id)
    } catch (error) {
      setSectionErrors((current) => ({
        ...current,
        soulseek: formatWantListError(error, 'Failed to run Soulseek search')
      }))
    } finally {
      setIsLoadingSoulseek(false)
    }
  }, [item, loadSoulseekResults, soulseekQuery])

  const runBusyAction = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusyAction(key)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(formatWantListError(error))
    } finally {
      setBusyAction(null)
    }
  }, [])

  return {
    item,
    editState,
    sourceItem,
    setEditState,
    soulseekQuery,
    setSoulseekQuery,
    youtubeQuery,
    setYoutubeQuery,
    collectionQuery,
    setCollectionQuery,
    soulseekResults,
    downloadAttempts,
    youtubeResults,
    collectionResults,
    isLoading,
    isSaving,
    isLoadingSoulseek,
    isLoadingSourceItem,
    isLoadingYouTube,
    isLoadingCollection,
    errorMessage,
    actionError,
    sourceItemError,
    busyAction,
    sectionErrors,
    actions: {
      save,
      searchSoulseek,
      searchYouTube: () => loadYouTubeResults(youtubeQuery, item),
      searchCollection: () => loadCollectionResults(collectionQuery, item),
      importFile: (filename: string) =>
        runBusyAction(`import:${filename}`, async () => {
          if (!item) {
            return
          }
          await api.wantList.import(item.id, filename)
        }),
      importDownload: (attempt: DownloadAttempt) =>
        runBusyAction(`import-download:${attempt.id}`, async () => {
          if (!item || !attempt.localFilename) return
          await api.wantList.import(item.id, attempt.localFilename, attempt.id)
          await loadDownloadAttempts(item.id)
        }),
      selectDownload: (attempt: DownloadAttempt) =>
        runBusyAction(`select-download:${attempt.id}`, async () => {
          if (!item) return
          const updated = await api.wantList.selectDownload(item.id, attempt.id)
          if (updated) setItem(updated)
        }),
      download: (candidate: SlskdCandidate) =>
        runBusyAction(`download:${candidate.username}:${candidate.filename}`, async () => {
          if (!item) {
            return
          }
          await api.wantList.download(item.id, candidate.username, candidate.filename, candidate.size)
          await loadDownloadAttempts(item.id)
        }),
      showInFinder: (filename: string) => {
        void api.collection.showInFinder(filename).catch((error) => {
          setActionError(formatWantListError(error))
        })
      },
      openInPlayer: (filename: string) => {
        void api.collection.openInPlayer(filename).catch((error) => {
          setActionError(formatWantListError(error))
        })
      }
    }
  }
}

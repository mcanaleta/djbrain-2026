import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollectionItem, SlskdCandidate, WantListItem } from '../../../../shared/api'
import type { OnlineSearchItem } from '../../../../shared/online-search'
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function waitForSoulseekCompletion(id: number): Promise<WantListItem | null> {
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    const item = await window.api.wantList.get(id)
    if (!item) {
      return null
    }
    if (item.pipelineStatus !== 'searching') {
      return item
    }
    await sleep(1_500)
  }

  return window.api.wantList.get(id)
}

export function useWantListItemPage(wantId: string | undefined) {
  const numericId = Number(wantId)
  const [item, setItem] = useState<WantListItem | null>(null)
  const [editState, setEditState] = useState<WantListEditState | null>(null)
  const [soulseekQuery, setSoulseekQuery] = useState('')
  const [youtubeQuery, setYoutubeQuery] = useState('')
  const [collectionQuery, setCollectionQuery] = useState('')
  const [soulseekResults, setSoulseekResults] = useState<SlskdCandidate[]>([])
  const [youtubeResults, setYoutubeResults] = useState<WantListVideoResult[]>([])
  const [collectionResults, setCollectionResults] = useState<WantListLocalResult[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoadingSoulseek, setIsLoadingSoulseek] = useState(false)
  const [isLoadingYouTube, setIsLoadingYouTube] = useState(false)
  const [isLoadingCollection, setIsLoadingCollection] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({
    soulseek: null,
    youtube: null,
    collection: null
  })

  const itemRequestRef = useRef(0)
  const youtubeRequestRef = useRef(0)
  const collectionRequestRef = useRef(0)

  const loadSoulseekResults = useCallback(async (id: number): Promise<void> => {
    setSectionErrors((current) => ({ ...current, soulseek: null }))
    const results = await window.api.wantList.getCandidates(id)
    setSoulseekResults(results)
  }, [])

  const loadYouTubeResults = useCallback(async (query: string, fallbackItem?: WantListItem | null): Promise<void> => {
    const effectiveQuery = query.trim() || (fallbackItem ? buildSavedResearchQuery(fallbackItem) : '')
    const requestId = youtubeRequestRef.current + 1
    youtubeRequestRef.current = requestId
    setIsLoadingYouTube(true)
    setSectionErrors((current) => ({ ...current, youtube: null }))

    try {
      const response = await window.api.onlineSearch.search(effectiveQuery, 'online')
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
        window.api.collection.list(effectiveQuery),
        window.api.collection.listDownloads(effectiveQuery)
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
        const nextItem = await window.api.wantList.get(numericId)
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
  }, [loadCollectionResults, loadSoulseekResults, loadYouTubeResults, numericId])

  useEffect(() => {
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return
    }

    return window.api.wantList.onItemUpdated((updated) => {
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
    })
  }, [loadSoulseekResults, numericId])

  const save = useCallback(async (): Promise<void> => {
    if (!item || !editState) {
      return
    }

    setIsSaving(true)
    setActionError(null)
    try {
      const updated = await window.api.wantList.update(item.id, toWantListAddInput(editState))
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
      const updated = await window.api.wantList.search(item.id, soulseekQuery)
      if (updated) {
        setItem(updated)
      }

      const completed = await waitForSoulseekCompletion(item.id)
      if (completed) {
        setItem(completed)
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
    setEditState,
    soulseekQuery,
    setSoulseekQuery,
    youtubeQuery,
    setYoutubeQuery,
    collectionQuery,
    setCollectionQuery,
    soulseekResults,
    youtubeResults,
    collectionResults,
    isLoading,
    isSaving,
    isLoadingSoulseek,
    isLoadingYouTube,
    isLoadingCollection,
    errorMessage,
    actionError,
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
          await window.api.wantList.import(item.id, filename)
        }),
      download: (candidate: SlskdCandidate) =>
        runBusyAction(`download:${candidate.username}:${candidate.filename}`, async () => {
          if (!item) {
            return
          }
          await window.api.wantList.download(item.id, candidate.username, candidate.filename, candidate.size)
        }),
      showInFinder: (filename: string) => {
        void window.api.collection.showInFinder(filename).catch((error) => {
          setActionError(formatWantListError(error))
        })
      },
      openInPlayer: (filename: string) => {
        void window.api.collection.openInPlayer(filename).catch((error) => {
          setActionError(formatWantListError(error))
        })
      }
    }
  }
}

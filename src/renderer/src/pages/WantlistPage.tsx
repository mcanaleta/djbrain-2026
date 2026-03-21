import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { WantListItem } from '../../../shared/api'
import { ActionButton, DataTable, Notice, Pill, ViewSection, type DataTableColumn } from '../components/view'
import { fileBasename } from '../lib/music-file'
import {
  canResetWantListItem,
  formatWantListError,
  isWantListItemBusy,
  WANT_LIST_STATUS_CLASS,
  WANT_LIST_STATUS_LABEL,
  type WantListPipelineStatus
} from '../features/wantlist/view-model'

function WantListStatusBadge({ status }: { status: WantListPipelineStatus }): React.JSX.Element {
  return (
    <Pill
      className={WANT_LIST_STATUS_CLASS[status]}
      pulse={(['searching', 'downloading', 'identifying', 'importing'] as WantListPipelineStatus[]).includes(status)}
    >
      {WANT_LIST_STATUS_LABEL[status]}
    </Pill>
  )
}

function WantListItemActivity({ item }: { item: WantListItem }): React.JSX.Element {
  if (item.pipelineStatus === 'error' && item.pipelineError) {
    return <span title={item.pipelineError}>{item.pipelineError}</span>
  }
  if (item.importedFilename) {
    return <span title={item.importedFilename}>{fileBasename(item.importedFilename)}</span>
  }
  if (item.downloadFilename) {
    return <span title={item.downloadFilename}>{fileBasename(item.downloadFilename)}</span>
  }
  return <span className="text-zinc-600">—</span>
}

export default function WantlistPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [items, setItems] = useState<WantListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setErrorMessage(null)
    void window.api.wantList
      .list()
      .then((result) => setItems(result))
      .catch((error) => {
        setErrorMessage(formatWantListError(error, 'Failed to load want list'))
      })
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
    const unsub = window.api.wantList.onItemUpdated((updated) => {
      setItems((prev) => {
        const existing = prev.some((item) => item.id === updated.id)
        if (!existing) {
          return [updated, ...prev]
        }
        return prev.map((item) => (item.id === updated.id ? updated : item))
      })
    })
    unsubRef.current = unsub
    return () => {
      unsub()
      unsubRef.current = null
    }
  }, [load])

  const handleUpdated = useCallback((updated: WantListItem) => {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
  }, [])

  const handleRemoved = useCallback((id: number) => {
    void window.api.wantList.remove(id).then(() => {
      setItems((prev) => prev.filter((item) => item.id !== id))
    })
  }, [])

  const columns = useMemo<DataTableColumn<WantListItem>[]>(
    () => [
      {
        key: 'status',
        header: 'Status',
        cellClassName: 'whitespace-nowrap',
        render: (item) => <WantListStatusBadge status={item.pipelineStatus} />
      },
      {
        key: 'artist',
        header: 'Artist',
        cellClassName: 'max-w-[150px] truncate font-medium text-zinc-100',
        render: (item) => item.artist
      },
      {
        key: 'title',
        header: 'Title',
        cellClassName: 'max-w-[220px] truncate',
        render: (item) => item.title || '—'
      },
      {
        key: 'version',
        header: 'Version',
        cellClassName: 'max-w-[140px] truncate text-zinc-400',
        render: (item) => item.version ?? '—'
      },
      {
        key: 'album',
        header: 'Album',
        headClassName: 'hidden lg:table-cell',
        cellClassName: 'hidden max-w-[170px] truncate text-zinc-500 lg:table-cell',
        render: (item) => item.album ?? '—'
      },
      {
        key: 'length',
        header: 'Len',
        headClassName: 'hidden md:table-cell',
        cellClassName: 'hidden whitespace-nowrap text-zinc-500 md:table-cell',
        render: (item) => item.length ?? '—'
      },
      {
        key: 'hits',
        header: 'Hits',
        cellClassName: 'whitespace-nowrap text-zinc-400',
        render: (item) => (item.searchResultCount > 0 ? item.searchResultCount : '—')
      },
      {
        key: 'activity',
        header: 'Activity',
        headClassName: 'hidden xl:table-cell',
        cellClassName: 'hidden max-w-[180px] truncate text-[10px] text-zinc-400 xl:table-cell',
        render: (item) => <WantListItemActivity item={item} />
      },
      {
        key: 'actions',
        header: 'Actions',
        headClassName: 'text-right',
        cellClassName: 'w-[1%]',
        render: (item) => {
          const isBusy = isWantListItemBusy(item)
          const canReset = canResetWantListItem(item)

          return (
            <div className="flex items-center justify-end gap-1">
              <ActionButton
                size="xs"
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation()
                  void window.api.wantList.search(item.id).then((updated) => {
                    if (updated) handleUpdated(updated)
                  })
                }}
              >
                {item.searchResultCount > 0 ? 'Re' : 'Go'}
              </ActionButton>
              {canReset ? (
                <ActionButton
                  size="xs"
                  disabled={isBusy}
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.api.wantList.resetPipeline(item.id).then((updated) => {
                      if (updated) handleUpdated(updated)
                    })
                  }}
                >
                  ↺
                </ActionButton>
              ) : null}
              <ActionButton
                size="xs"
                tone="danger"
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation()
                  handleRemoved(item.id)
                }}
              >
                ×
              </ActionButton>
            </div>
          )
        }
      }
    ],
    [handleRemoved, handleUpdated]
  )

  return (
    <div className="space-y-3">
      <ViewSection
        title="Wanted Tracks"
        subtitle="Compact index of tracked songs and current pipeline state."
        aside={<div className="text-[11px] text-zinc-500">{items.length} items</div>}
      >
        <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-amber-300/80">
          Want List
        </div>
      </ViewSection>

      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}

      {isLoading ? (
        <Notice>Loading…</Notice>
      ) : items.length === 0 ? (
        <Notice>No tracks yet. Add tracks from a Discogs release page.</Notice>
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          getRowKey={(item) => String(item.id)}
          onRowClick={(item) => navigate(`/wantlist/${item.id}`)}
          tableClassName="min-w-[860px]"
        />
      )}
    </div>
  )
}

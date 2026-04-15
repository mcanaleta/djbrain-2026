import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { WantListItem } from '../../../shared/api'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { Notice } from '../components/view/Notice'
import { ViewSection } from '../components/view/ViewSection'
import {
  canResetWantListItem,
  formatWantListError,
  isWantListItemBusy
} from '../features/wantlist/view-model'
import { WantListStatusBadge } from '../features/wantlist/WantListStatusBadge'

export default function WantlistPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [items, setItems] = useState<WantListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setErrorMessage(null)
    void api.wantList
      .list()
      .then((result) => setItems(result))
      .catch((error) => {
        setErrorMessage(formatWantListError(error, 'Failed to load want list'))
      })
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
    const unsub = api.wantList.onItemUpdated((updated) => {
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
    void api.wantList.remove(id).then(() => {
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
        cellClassName: 'max-w-[160px] truncate font-medium text-zinc-100',
        render: (item) => item.artist
      },
      {
        key: 'title',
        header: 'Title',
        cellClassName: 'max-w-[240px] truncate',
        render: (item) => item.title || '—'
      },
      {
        key: 'length',
        header: 'Len',
        cellClassName: 'whitespace-nowrap text-zinc-500',
        render: (item) => item.length ?? '—'
      },
      {
        key: 'actions',
        header: '',
        cellClassName: 'w-[1%]',
        render: (item) => {
          const isBusy = isWantListItemBusy(item)
          const canReset = canResetWantListItem(item)
          return (
            <div className="flex items-center justify-end gap-1">
              {item.discogsReleaseId != null ? (
                <Link
                  to={`/discogs/${item.discogsEntityType ?? 'release'}/${item.discogsReleaseId}`}
                  onClick={(event) => event.stopPropagation()}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:border-amber-700/60 hover:text-amber-200"
                  title="View on Discogs"
                >
                  ↗
                </Link>
              ) : null}
              <ActionButton size="xs" disabled={isBusy} onClick={(event) => {
                event.stopPropagation()
                void api.wantList.search(item.id).then((updated) => {
                  if (updated) handleUpdated(updated)
                })
              }}>
                {item.searchResultCount > 0 ? 'Re' : 'Go'}
              </ActionButton>
              {canReset ? (
                <ActionButton size="xs" disabled={isBusy} onClick={(event) => {
                  event.stopPropagation()
                  void api.wantList.resetPipeline(item.id).then((updated) => {
                    if (updated) handleUpdated(updated)
                  })
                }}>
                  ↺
                </ActionButton>
              ) : null}
              <ActionButton size="xs" tone="danger" disabled={isBusy} onClick={(event) => {
                event.stopPropagation()
                handleRemoved(item.id)
              }}>
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
          tableClassName="min-w-[480px]"
        />
      )}
    </div>
  )
}

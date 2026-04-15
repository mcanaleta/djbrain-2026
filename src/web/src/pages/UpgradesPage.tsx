import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { UpgradeCase, UpgradeCaseStatus } from '../../../shared/api'
import { api } from '../api/client'
import { ActionButton } from '../components/view/ActionButton'
import { DataTable, type DataTableColumn } from '../components/view/DataTable'
import { Notice } from '../components/view/Notice'
import { PageHero } from '../components/view/PageHero'
import { Pill } from '../components/view/Pill'
import { ViewSection } from '../components/view/ViewSection'
import { deriveTrackSummaryFromFilename, formatCompactDuration } from '../lib/music-file'
import { getErrorMessage } from '../lib/error-utils'

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

type UpgradeRow = UpgradeCase & {
  artist: string
  title: string
}

function formatError(error: unknown): string {
  return getErrorMessage(error, 'Unexpected upgrades error')
}

function makeColumns(navigate: (path: string) => void): DataTableColumn<UpgradeRow>[] {
  return [
    {
      key: 'track',
      header: 'Track',
      cellClassName: 'max-w-[240px]',
      render: (row) => (
        <div className="truncate">
          <div className="truncate text-zinc-100">{row.title}</div>
          <div className="truncate text-zinc-400">{row.artist}</div>
        </div>
      )
    },
    {
      key: 'status',
      header: 'Status',
      cellClassName: 'whitespace-nowrap',
      render: (row) => <Pill tone={STATUS_TONE[row.status]}>{row.status.replace(/_/g, ' ')}</Pill>
    },
    {
      key: 'lengths',
      header: 'Lengths',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) =>
        `${formatCompactDuration(row.currentDurationSeconds)} -> ${formatCompactDuration(row.referenceDurationSeconds)}`
    },
    {
      key: 'candidates',
      header: 'Candidates',
      cellClassName: 'whitespace-nowrap text-zinc-300',
      render: (row) => `${row.localCandidateCount} local / ${row.candidateCount} remote`
    },
    {
      key: 'path',
      header: 'Path',
      cellClassName: 'max-w-[340px] truncate text-zinc-500',
      render: (row) => <span title={row.collectionFilename}>{row.collectionFilename}</span>
    },
    {
      key: 'open',
      header: '',
      cellClassName: 'w-[1%] whitespace-nowrap',
      render: (row) => (
        <ActionButton size="xs" tone="primary" onClick={() => navigate(`/upgrades/${row.id}`)}>
          Open
        </ActionButton>
      )
    }
  ]
}

export default function UpgradesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [cases, setCases] = useState<UpgradeCase[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadCases = useCallback(async (): Promise<void> => {
    try {
      setCases(await api.upgrades.list())
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCases()
  }, [loadCases])

  useEffect(() => {
    if (!cases.some((item) => ['searching', 'downloading'].includes(item.status))) return
    const poll = window.setInterval(() => {
      void loadCases()
    }, 2000)
    return () => window.clearInterval(poll)
  }, [cases, loadCases])

  const rows = useMemo(
    () =>
      cases.map((item) => {
        const summary = deriveTrackSummaryFromFilename(item.collectionFilename)
        return { ...item, artist: summary.artist, title: summary.title }
      }),
    [cases]
  )
  const replacementRows = rows.filter((item) => item.replacementFilename || item.archiveFilename)
  const activeRows = rows.filter((item) => !item.replacementFilename && !item.archiveFilename)
  const columns = useMemo(() => makeColumns(navigate), [navigate])

  return (
    <div className="space-y-4">
      <PageHero
        eyebrow="Upgrade Cases"
        title="Upgrades"
        subtitle="All upgrade/replacement work in one place."
        meta={
          <>
            <span>{rows.length} total</span>
            <span>{activeRows.length} active</span>
            <span>{replacementRows.length} replacements</span>
          </>
        }
        aside={
          <ActionButton size="xs" onClick={() => void loadCases()}>
            Refresh
          </ActionButton>
        }
      />

      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}

      <ViewSection
        title="Active"
        subtitle="Searches, downloads, candidate review, and pending replacements."
        className="p-0"
        bodyClassName="mt-0"
      >
        <DataTable
          columns={columns}
          rows={activeRows}
          getRowKey={(row) => String(row.id)}
          loading={isLoading}
          loadingMessage="Loading upgrade cases…"
          emptyMessage="No active upgrade cases."
          className="rounded-none border-0"
          tableClassName="min-w-[980px]"
        />
      </ViewSection>

      <ViewSection
        title="Replacements"
        subtitle="Tracks already swapped or archived."
        className="p-0"
        bodyClassName="mt-0"
      >
        <DataTable
          columns={columns}
          rows={replacementRows}
          getRowKey={(row) => String(row.id)}
          loading={false}
          emptyMessage="No replacements yet."
          className="rounded-none border-0"
          tableClassName="min-w-[980px]"
        />
      </ViewSection>
    </div>
  )
}

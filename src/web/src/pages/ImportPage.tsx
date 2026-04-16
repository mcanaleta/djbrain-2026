import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LabeledInput } from '../components/view/LabeledInput'
import { Notice } from '../components/view/Notice'
import { useHeaderActions } from '../context/HeaderActionsContext'
import { ImportTracksTable } from '../features/import/ImportTracksTable'
import { useImportPageData } from '../features/import/useImportPageData'
import { buildImportReviewHref } from '../lib/urls'

export default function ImportPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [routeSearchParams] = useSearchParams()
  const initialQuery = routeSearchParams.get('query') ?? ''
  const [query, setQuery] = useState(initialQuery)
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery)
  const {
    total,
    groupedRows,
    isLoading,
    musicFolderPath,
    clearFoldersResult,
    queueMessage,
    errorMessage,
    statusLastError,
    refetch,
    headerActions
  } = useImportPageData(submittedQuery)

  useHeaderActions(headerActions)

  return (
    <div className="space-y-4">
      {clearFoldersResult ? <Notice>{clearFoldersResult}</Notice> : null}
      <div className="flex items-end gap-3">
        <LabeledInput
          label="Search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            const nextQuery = query.trim()
            if (nextQuery === submittedQuery) void refetch()
            else setSubmittedQuery(nextQuery)
          }}
          placeholder="Search download items…"
          className="flex-1"
          inputClassName="h-9 rounded-md border-zinc-800 bg-zinc-950/30"
        />
        <div className="shrink-0 pb-1 text-xs text-zinc-400">
          {total} items · {groupedRows.length} tracks
        </div>
      </div>
      <ImportTracksTable
        rows={groupedRows}
        loading={isLoading}
        musicFolderPath={musicFolderPath}
        onOpenRow={(row) => navigate(buildImportReviewHref(row.bestFile.filename, submittedQuery))}
      />

      {queueMessage ? <Notice>{queueMessage}</Notice> : null}
      {errorMessage || statusLastError ? (
        <Notice tone="error" className="text-sm">
          {errorMessage ?? statusLastError}
        </Notice>
      ) : null}
    </div>
  )
}

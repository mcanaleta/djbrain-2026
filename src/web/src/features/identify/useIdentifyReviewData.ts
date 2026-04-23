import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { IdentifyViewCandidate } from './IdentifyRecordCandidates'
import { api } from '../../api/client'
import { readIdentifyIteration } from './iteration'
import { identifyInferredReferences, identifyReviewData, identifySearchHint } from './reviewData'

export function useIdentifyReviewData(itemId: number, scope: 'downloads' | 'collection', query: string, filter: 'all' | 'verified' | 'unverified') {
  const [searchDraft, setSearchDraft] = useState('')
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null)
  const { data: item, error, isPending, refetch } = useQuery({
    queryKey: ['identify', 'item', itemId],
    queryFn: () => api.collection.getById(itemId),
    enabled: Number.isInteger(itemId) && itemId > 0
  })

  useEffect(() => {
    setSearchDraft(identifySearchHint(item ?? null))
  }, [item?.id])

  const nextItemId = useMemo(() => {
    const ids = readIdentifyIteration(scope, query, filter)
    const index = ids.indexOf(itemId)
    return index >= 0 ? ids[index + 1] ?? null : null
  }, [filter, itemId, query, scope])
  const reviewData = identifyReviewData(item ?? null)
  const inferredReferences = useMemo(() => identifyInferredReferences(item ?? null), [item])
  const candidateById = useMemo(() => new Map((item?.identification?.candidates ?? []).map((candidate) => [candidate.id, candidate] as const)), [item?.identification?.candidates])
  const groups = useMemo<IdentifyViewCandidate[]>(
    () =>
      (reviewData?.recordCandidates ?? [])
        .map((candidate) => ({ ...candidate, references: candidate.references.filter((reference) => reference.provider !== 'tags' && reference.provider !== 'filename') }))
        .filter((candidate) => candidate.references.length > 0)
        .map((candidate) => ({
          ...candidate,
          canonical: candidate.recordingId != null && candidate.recordingId === item?.recordingId && item.recordingCanonical ? item.recordingCanonical : candidate.canonical,
          selectableCandidateId:
            candidate.references.find((reference) => {
              const row = reference.candidateId != null ? candidateById.get(reference.candidateId) ?? null : null
              return Boolean(reference.assignable && row && row.disposition !== 'rejected' && reference.candidateId != null)
            })?.candidateId ?? null,
          selected: false,
          references: candidate.references.map((reference) => {
            const row = reference.candidateId != null ? candidateById.get(reference.candidateId) ?? null : null
            return { ...reference, selected: reference.candidateId != null && reference.candidateId === selectedCandidateId, selectable: Boolean(reference.assignable && row && row.disposition !== 'rejected') }
          })
        }))
        .map((candidate) => ({ ...candidate, selected: candidate.selectableCandidateId != null && candidate.selectableCandidateId === selectedCandidateId })),
    [candidateById, item?.recordingCanonical, item?.recordingId, reviewData?.recordCandidates, selectedCandidateId]
  )

  useEffect(() => {
    const accepted = (item?.identification?.candidates ?? []).find((candidate) => candidate.disposition === 'accepted' && (candidate.provider === 'discogs' || candidate.provider === 'musicbrainz'))?.id ?? null
    const firstSelectable = groups.find((candidate) => candidate.selectableCandidateId != null)?.selectableCandidateId ?? null
    const next = accepted ?? firstSelectable
    if (selectedCandidateId && groups.some((candidate) => candidate.selectableCandidateId === selectedCandidateId)) return
    setSelectedCandidateId(next)
  }, [groups, item?.identification?.candidates, selectedCandidateId])

  return { item, error, isPending, refetch, searchDraft, setSearchDraft, selectedCandidateId, setSelectedCandidateId, nextItemId, reviewData, inferredReferences, groups }
}

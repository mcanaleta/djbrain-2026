import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IdentifyRecordCandidate, IdentifyReference } from '@djbrain/shared/api'
import { ActionButton } from '../../components/view/ActionButton'
import { formatCompactDuration } from '../../lib/music-file'
import { buildRecordingHref, discogsReleaseUrlFromExternalKey, musicBrainzRecordingUrlFromExternalKey } from '../../lib/urls'

export type IdentifyViewReference = IdentifyReference & {
  selected: boolean
  selectable: boolean
}

export type IdentifyViewCandidate = Omit<IdentifyRecordCandidate, 'references'> & {
  selectableCandidateId: number | null
  selected: boolean
  references: IdentifyViewReference[]
}

const sourceUrl = (reference: IdentifyReference): string | null =>
  reference.link ?? discogsReleaseUrlFromExternalKey(reference.externalKey) ?? musicBrainzRecordingUrlFromExternalKey(reference.externalKey)

const refLabel = (reference: IdentifyReference): string => reference.provider === 'youtube' ? 'youtube' : reference.provider

const candidateLength = (candidate: IdentifyRecordCandidate): number | null =>
  candidate.references.find((reference) => reference.durationSeconds != null)?.durationSeconds ?? null

const lineTitle = (reference: IdentifyReference): string =>
  reference.provider === 'discogs'
    ? reference.releaseTitle ?? 'Discogs release'
    : reference.provider === 'musicbrainz'
      ? reference.releaseTitle ?? 'MusicBrainz release'
      : reference.provider === 'youtube'
        ? reference.title ?? 'YouTube video'
        : [reference.artist, reference.title].filter(Boolean).join(' - ') || refLabel(reference)

const lineMeta = (reference: IdentifyReference): string[] =>
  reference.provider === 'discogs'
    ? [
        reference.trackPosition,
        [reference.artist, reference.title].filter(Boolean).join(' - ') || null,
        reference.format,
        reference.year,
        reference.durationSeconds != null ? formatCompactDuration(reference.durationSeconds) : null
      ].filter((value): value is string => Boolean(value))
    : reference.provider === 'musicbrainz'
      ? [
          reference.trackPosition,
          [reference.artist, reference.title].filter(Boolean).join(' - ') || null,
          reference.format,
          reference.year,
          reference.durationSeconds != null ? formatCompactDuration(reference.durationSeconds) : null
        ].filter((value): value is string => Boolean(value))
      : [
          reference.label && `Label ${reference.label}`,
          reference.format,
          reference.catalogNumber && `Ref ${reference.catalogNumber}`,
          reference.country,
          reference.trackPosition && `Track ${reference.trackPosition}`,
          reference.year && `Year ${reference.year}`,
          reference.durationSeconds != null && `Length ${formatCompactDuration(reference.durationSeconds)}`
        ].filter((value): value is string => Boolean(value))

const isDiscogsReference = (reference: IdentifyReference): boolean => reference.provider === 'discogs'
const isMusicBrainzReference = (reference: IdentifyReference): boolean => reference.provider === 'musicbrainz'
const mainSource = (candidate: IdentifyViewCandidate): string =>
  refLabel(candidate.references.find((reference) => reference.assignable) ?? candidate.references[0])

const tagDetails = (reference: IdentifyReference): Array<[string, string]> =>
  [
    ['Source', reference.tagSource ?? '—'],
    ['Comments', reference.comments ?? '—'],
    ['Album', reference.releaseTitle ?? '—'],
    ['Label', reference.label ?? '—'],
    ['Catalog', reference.catalogNumber ?? '—'],
    ['Track', reference.trackPosition ?? '—'],
    ['Discogs Release', reference.discogsReleaseId != null ? String(reference.discogsReleaseId) : '—'],
    ['Discogs Track', reference.discogsTrackPosition ?? '—']
  ]

const titleWithVersion = (title: string | null | undefined, version: string | null | undefined): string =>
  title ? `${title}${version ? ` (${version})` : ''}` : '—'

export function IdentifyRecordCandidates({
  candidates,
  inferredReferences,
  onPlayLocal,
  onPlayExternal,
  onToggleCandidate
}: {
  candidates: IdentifyViewCandidate[]
  inferredReferences: IdentifyReference[]
  onPlayLocal: (reference: IdentifyReference) => void
  onPlayExternal: (url: string) => void
  onToggleCandidate: (candidateId: number) => void
}): React.JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const toggleExpanded = (key: string): void =>
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-zinc-950/50 text-zinc-500">
          <tr>
            <th className="w-[1%] whitespace-nowrap px-2 py-1.5 font-medium" />
            <th className="px-2 py-1.5 font-medium">Artist</th>
            <th className="px-2 py-1.5 font-medium">Title</th>
            <th className="px-2 py-1.5 font-medium">Year</th>
            <th className="px-2 py-1.5 font-medium">Length</th>
          </tr>
        </thead>
        <tbody>
          {inferredReferences.map((reference) => (
            <Fragment key={reference.key}>
              <tr className="border-t border-zinc-800 bg-zinc-950/35">
                <td className="whitespace-nowrap px-2 py-1.5 align-top text-zinc-300">
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300">{refLabel(reference)}</span>
                </td>
                <td className="px-2 py-1.5 align-top text-zinc-100">{reference.artist ?? '—'}</td>
                <td className="px-2 py-1.5 align-top text-zinc-100">{titleWithVersion(reference.title, reference.version)}</td>
                <td className="px-2 py-1.5 align-top text-zinc-300">{reference.year ?? '—'}</td>
                <td className="px-2 py-1.5 align-top text-zinc-400">
                  <div className="flex items-center gap-2">
                    <ActionButton
                      size="xs"
                      onClick={() => (reference.provider === 'youtube' && sourceUrl(reference) ? onPlayExternal(sourceUrl(reference)!) : onPlayLocal(reference))}
                    >
                      Play
                    </ActionButton>
                    <span>{formatCompactDuration(reference.durationSeconds)}</span>
                    {reference.provider === 'tags' ? (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(reference.key)}
                        className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-100"
                      >
                        {expandedKeys.has(reference.key) ? 'Hide' : 'Show'}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
              {reference.provider === 'tags' && expandedKeys.has(reference.key) ? (
                <tr className="border-t border-zinc-900 bg-zinc-950/50">
                  <td />
                  <td colSpan={4} className="px-2 py-2">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                      {tagDetails(reference).map(([label, value]) => (
                        <span key={`${reference.key}:${label}`} className="text-zinc-400">
                          <span className="text-zinc-500">{label}</span> {value}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
          {candidates.map((candidate) => (
            <Fragment key={candidate.key}>
              <tr className={`border-t border-zinc-800 ${candidate.selected ? 'bg-amber-950/20' : 'bg-zinc-950/20'}`}>
                <td className="whitespace-nowrap px-2 py-1.5 align-top">
                  <div className="flex items-center gap-1.5">
                    {candidate.selectableCandidateId != null ? (
                      <input
                        type="checkbox"
                        checked={candidate.selected}
                        onChange={() => onToggleCandidate(candidate.selectableCandidateId!)}
                        className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-950 text-amber-500"
                      />
                    ) : (
                      <span className="inline-block h-3.5 w-3.5" />
                    )}
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300">
                      {mainSource(candidate)}
                    </span>
                    {candidate.recordingId ? (
                      <Link className="text-zinc-400 hover:text-zinc-100" to={buildRecordingHref(candidate.recordingId)}>
                        #{candidate.recordingId}
                      </Link>
                    ) : null}
                  </div>
                </td>
                <td className="px-2 py-1.5 align-top text-zinc-100">{candidate.canonical.artist ?? '—'}</td>
                <td className="px-2 py-1.5 align-top text-zinc-100">{titleWithVersion(candidate.canonical.title, candidate.canonical.version)}</td>
                <td className="px-2 py-1.5 align-top text-zinc-300">{candidate.canonical.year ?? '—'}</td>
                <td className="px-2 py-1.5 align-top text-zinc-400">
                  <div className="flex items-center gap-2">
                    <span>{formatCompactDuration(candidateLength(candidate))}</span>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(candidate.key)}
                      className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-100"
                    >
                      {expandedKeys.has(candidate.key) ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </td>
              </tr>
              {expandedKeys.has(candidate.key) ? (
                <tr className="border-t border-zinc-900 bg-zinc-950/50">
                  <td />
                  <td colSpan={4} className="px-2 py-2">
                    <div className="space-y-1.5">
                      {candidate.references.map((reference) => {
                        const url = sourceUrl(reference)
                        const thirdPartyUrl = url && (reference.provider === 'discogs' || reference.provider === 'musicbrainz') ? url : null
                        const discogs = isDiscogsReference(reference)
                        const musicbrainz = isMusicBrainzReference(reference)
                        const sourceTrack = [reference.trackPosition, [reference.artist, reference.title].filter(Boolean).join(' - ') || null]
                          .filter((value): value is string => Boolean(value))
                          .join('  ')
                        return (
                          <div key={reference.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-zinc-800/80 bg-zinc-950/40 px-2 py-1.5">
                            <ActionButton
                              size="xs"
                              onClick={() => (reference.provider === 'youtube' && url ? onPlayExternal(url) : onPlayLocal(reference))}
                            >
                              Play
                            </ActionButton>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300">{refLabel(reference)}</span>
                            <span className={discogs || musicbrainz ? 'font-medium text-zinc-100' : 'text-zinc-200'}>{lineTitle(reference)}</span>
                            {sourceTrack ? <span className={discogs || musicbrainz ? 'text-zinc-100' : 'text-zinc-200'}>{sourceTrack}</span> : null}
                            {lineMeta(reference).map((value) => (
                              <span key={`${reference.key}:${value}`} className={discogs || musicbrainz ? 'text-zinc-300' : 'text-zinc-500'}>
                                {value}
                              </span>
                            ))}
                            {thirdPartyUrl ? <a className="text-zinc-400 hover:text-zinc-100" href={thirdPartyUrl} target="_blank" rel="noreferrer">Open</a> : null}
                          </div>
                        )
                      })}
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

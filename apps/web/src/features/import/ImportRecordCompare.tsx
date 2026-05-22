import { AudioCompareControls } from '../../components/AudioCompareControls'
import { Notice } from '../../components/view/Notice'
import { localFileUrl } from '../../context/PlayerContext'
import { useAudioCompare } from '../../hooks/useAudioCompare'

export function ImportRecordCompare({
  leftFilename,
  rightFilename,
  leftDuration,
  rightDuration,
  enabled
}: {
  leftFilename: string | null
  rightFilename: string | null
  leftDuration: number | null
  rightDuration: number | null
  enabled: boolean
}): React.JSX.Element {
  const audio = useAudioCompare({
    sourceUrl: leftFilename ? localFileUrl('', leftFilename) : '',
    existingUrl: rightFilename ? localFileUrl('', rightFilename) : '',
    enabled,
    resetKey: `${leftFilename ?? ''}:${rightFilename ?? ''}`
  })

  if (!leftFilename || !rightFilename) {
    return <Notice>Select two files on this record to use the crossfader.</Notice>
  }

  return (
    <div className="space-y-2">
      <AudioCompareControls
        left={{
          label: 'A',
          playing: audio.sourcePlaying,
          time: audio.sourceTime,
          duration: audio.sourceDuration || leftDuration,
          playLabel: 'Play A',
          pauseLabel: 'Pause A',
          onToggle: audio.sourcePlaying ? audio.pausePlayback : audio.playSource,
          onSeek: audio.syncSourceTime
        }}
        right={{
          label: 'B',
          playing: audio.existingPlaying,
          disabled: !enabled,
          time: audio.existingTime,
          duration: audio.existingDuration || rightDuration,
          playLabel: 'Play B',
          pauseLabel: 'Pause B',
          onToggle: audio.existingPlaying ? audio.pausePlayback : audio.playExisting,
          onSeek: audio.syncExistingTime
        }}
        linked={audio.linkPlayers}
        onToggleLinked={() => audio.setLinkPlayers((value) => !value)}
        crossfade={audio.crossfade}
        onCrossfade={audio.setCrossfade}
        crossfadeDisabled={!enabled}
      />
      <audio {...audio.sourceAudioProps} hidden />
      <audio {...audio.existingAudioProps} hidden />
    </div>
  )
}

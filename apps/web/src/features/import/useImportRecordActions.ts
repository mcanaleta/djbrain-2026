import { useQueryClient } from '@tanstack/react-query'
import type { DiscogsTrackMatch } from '@djbrain/shared/discogs-match'
import type { RecordingDetails } from '@djbrain/shared/api'
import { api } from '../../api/client'
import { useAsyncAction } from '../../hooks/useAsyncAction'

export function useImportRecordActions({
  recording,
  replacePair,
  importSourceFilename,
  importMatch,
  upgradeTargetFilename
}: {
  recording: RecordingDetails | null
  replacePair: { sourceFilename: string; targetFilename: string } | null
  importSourceFilename: string | null
  importMatch: DiscogsTrackMatch | null
  upgradeTargetFilename: string | null
}) {
  const queryClient = useQueryClient()
  const actions = useAsyncAction()
  const invalidateRecord = () =>
    Promise.all([
      recording ? queryClient.refetchQueries({ queryKey: ['collection', 'recording', recording.id] }) : Promise.resolve(),
      queryClient.refetchQueries({ queryKey: ['collection', 'downloads'] }),
      queryClient.invalidateQueries({ queryKey: ['collection', 'import-record-search'] }),
      queryClient.invalidateQueries({ queryKey: ['collection'] })
    ])

  return {
    ...actions,
    async assignToRecord(filename: string): Promise<void> {
      if (!recording) return
      await actions.run({
        key: `assign-${filename}`,
        action: async () => {
          await api.collection.assignRecording({ recordingId: recording.id, filenames: [filename] })
          await api.collection.reanalyze(filename)
          await invalidateRecord()
        },
        successMessage: 'File added to record and analyzed.',
        errorFallback: 'Failed to add file to record and analyze it'
      })
    },
    async analyzeFile(filename: string): Promise<void> {
      await actions.run({
        key: `analyze-${filename}`,
        action: async () => {
          await api.collection.reanalyze(filename)
          await invalidateRecord()
        },
        successMessage: 'File analyzed.',
        errorFallback: 'Failed to analyze file'
      })
    },
    async transcodeToMp3320(filename: string): Promise<void> {
      if (!recording) return
      await actions.run({
        key: `transcode-${filename}`,
        action: async () => {
          await api.collection.transcodeToMp3320(recording.id, filename)
          await invalidateRecord()
        },
        successMessage: '320 MP3 created.',
        errorFallback: 'Failed to create 320 MP3'
      })
    },
    async deleteFile(filename: string): Promise<void> {
      await actions.run({
        key: `delete-${filename}`,
        action: async () => {
          await api.collection.deleteFile(filename)
          await invalidateRecord()
        },
        successMessage: 'File deleted.',
        errorFallback: 'Failed to delete file'
      })
    },
    async replaceExistingSong(): Promise<void> {
      if (!recording || !replacePair) return
      await actions.run({
        key: `replace-${recording.id}`,
        action: async () => {
          await api.collection.replaceRecordFile(recording.id, replacePair.sourceFilename, replacePair.targetFilename)
          await invalidateRecord()
        },
        successMessage: 'Existing song replaced.',
        errorFallback: 'Failed to replace existing song'
      })
    },
    async importSingleDownload(): Promise<void> {
      if (!importSourceFilename || !importMatch) return
      await actions.run({
        key: `import-${importSourceFilename}`,
        action: async () => {
          await api.collection.commitImport({ filename: importSourceFilename, match: importMatch, mode: 'import_new' })
          await invalidateRecord()
        },
        successMessage: 'File imported.',
        errorFallback: 'Failed to import file'
      })
    },
    async openUpgradeCase(): Promise<void> {
      if (!upgradeTargetFilename) return
      await actions.run({
        key: `upgrade-${upgradeTargetFilename}`,
        action: async () => {
          await api.upgrades.open(upgradeTargetFilename)
        },
        successMessage: 'Better-version download queued.',
        errorFallback: 'Failed to open upgrade case'
      })
    }
  }
}

import { basename } from 'node:path'
import { unlink } from 'node:fs/promises'
import type { CollectionService } from '../backend/collection-service.ts'
import type { ImportService } from '../backend/import-service.ts'
import type { AppSettings } from '../backend/settings-store.ts'
import type { SlskdService } from '../backend/slskd-service.ts'
import type { UpgradeCandidate, UpgradeCase, UpgradeLocalCandidate } from '../shared/api.ts'
import { getDownloadFailureStatus, hasAcceptableUpgradeDuration, toMusicRelativePath } from './workflow-download-utils.ts'

export async function continueUpgradeDownloadPipeline({
  id,
  candidate,
  service,
  settings,
  slskdService,
  importService,
  buildLocalCandidate,
  appendLocalCandidate
}: {
  id: number
  candidate: UpgradeCandidate
  service: CollectionService
  settings: AppSettings
  slskdService: SlskdService
  importService: ImportService
  buildLocalCandidate: (filename: string, source: UpgradeLocalCandidate['source'], username: string | null, remotePath: string | null) => Promise<UpgradeLocalCandidate>
  appendLocalCandidate: (id: number, localCandidate: UpgradeLocalCandidate) => Promise<UpgradeCase | null>
}): Promise<void> {
  try {
    const result = await slskdService.waitForDownload(settings, candidate.username, candidate.filename)
    if (result !== 'Completed') {
      const upgradeCase = await service.upgradeCaseGet(id)
      await service.upgradeCaseUpdate(id, {
        status: getDownloadFailureStatus(upgradeCase),
        lastError: result === 'Timeout' ? 'Download timed out.' : 'Download failed or was cancelled.'
      })
      return
    }

    const localPath = await importService.resolveLocalPath(settings, candidate.filename)
    if (!localPath) {
      const upgradeCase = await service.upgradeCaseGet(id)
      await service.upgradeCaseUpdate(id, {
        status: getDownloadFailureStatus(upgradeCase),
        lastError: 'Downloaded file was not found in the configured download folders.'
      })
      return
    }

    await service.syncNow()
    const upgradeCase = await service.upgradeCaseGet(id)
    if (!upgradeCase) return
    const localCandidate = await buildLocalCandidate(toMusicRelativePath(settings, localPath), 'auto_download', candidate.username, candidate.filename)
    if (!hasAcceptableUpgradeDuration(localCandidate.durationSeconds, upgradeCase.referenceDurationSeconds)) {
      await unlink(localPath).catch(() => {})
      await service.syncNow()
      await service.upgradeCaseUpdate(id, {
        status: getDownloadFailureStatus(await service.upgradeCaseGet(id)),
        lastError: `Discarded ${basename(localCandidate.filename)} due to duration mismatch.`
      })
      return
    }

    await appendLocalCandidate(id, localCandidate)
    const sourceItem = await service.getItem(upgradeCase.collectionFilename)
    if (sourceItem?.recordingId) await service.assignRecording({ recordingId: sourceItem.recordingId, filenames: [localCandidate.filename] })
  } catch (error) {
    const upgradeCase = await service.upgradeCaseGet(id)
    await service.upgradeCaseUpdate(id, {
      status: getDownloadFailureStatus(upgradeCase),
      lastError: error instanceof Error ? error.message : 'Download failed'
    })
  }
}

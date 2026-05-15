export const RUNTIME_PROCESS_ROLES = ['downloader', 'sync', 'admin'] as const

export type RuntimeProcessRole = (typeof RUNTIME_PROCESS_ROLES)[number]
export type RuntimeProcessState = 'active' | 'stale' | 'missing'

export type RuntimeLeaseSnapshot = {
  role: string
  ownerId: string
  hostname: string | null
  pid: number | null
  priority: number
  codeVersion: string
  schemaVersion: number
  heartbeatAt: string
  leaseExpiresAt: string
}

export type RuntimeProcessStatus = {
  role: string
  state: RuntimeProcessState
  ownerId: string | null
  hostname: string | null
  pid: number | null
  priority: number | null
  codeVersion: string | null
  schemaVersion: number | null
  heartbeatAt: string | null
  leaseExpiresAt: string | null
  secondsUntilExpiry: number | null
  takeoverCommand: string
  databaseHref: string
}

export type RuntimeStatus = {
  codeSchemaVersion: number
  databaseSchemaVersion: number | null
  server: {
    automationEnabled: boolean
    serverBackgroundWorkersEnabled: boolean
    serverStartupSyncEnabled: boolean
  }
  processes: RuntimeProcessStatus[]
}

const COMMANDS: Record<string, string> = {
  downloader: 'npm run downloader',
  sync: 'npm run sync',
  admin: 'npm run admin'
}

export function takeoverCommand(role: string, ownerId = 'machook', priority = 50): string {
  return `${COMMANDS[role] ?? `npm run ${role}`} -- --owner-id ${ownerId} --priority ${priority} --takeover`
}

export function buildRuntimeProcessStatuses(
  leases: RuntimeLeaseSnapshot[],
  nowMs = Date.now(),
  takeoverOwnerId = 'machook',
  takeoverPriority = 50
): RuntimeProcessStatus[] {
  const byRole = new Map(leases.map((lease) => [lease.role, lease]))
  return RUNTIME_PROCESS_ROLES.map((role) => {
    const lease = byRole.get(role)
    const expiresMs = lease ? Date.parse(lease.leaseExpiresAt) : NaN
    const seconds = Number.isFinite(expiresMs) ? Math.ceil((expiresMs - nowMs) / 1000) : null
    return {
      role,
      state: lease ? (seconds != null && seconds > 0 ? 'active' : 'stale') : 'missing',
      ownerId: lease?.ownerId ?? null,
      hostname: lease?.hostname ?? null,
      pid: lease?.pid ?? null,
      priority: lease?.priority ?? null,
      codeVersion: lease?.codeVersion ?? null,
      schemaVersion: lease?.schemaVersion ?? null,
      heartbeatAt: lease?.heartbeatAt ?? null,
      leaseExpiresAt: lease?.leaseExpiresAt ?? null,
      secondsUntilExpiry: seconds,
      takeoverCommand: takeoverCommand(role, takeoverOwnerId, takeoverPriority),
      databaseHref: `/database/process_leases?filter=${encodeURIComponent(role)}`
    }
  })
}

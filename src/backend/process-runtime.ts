export type ProcessWorkerOptions = {
  intervalSeconds: number
  limit: number
  dryRun: boolean
  ownerId: string
  priority: number
  takeover: boolean
  leaseMs: number
}

type Env = Record<string, string | undefined>

type ProcessWorkerOptionsInput = {
  args: string[]
  env: Env
  hostname: string
  pid: number
  defaultIntervalSeconds: number
  defaultLimit: number
}

function readArg(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? null) : null
}

function readNumber(args: string[], env: Env, name: string, fallback: number): number {
  const envKey = name.replace(/^--/, 'DJBRAIN_').replace(/-/g, '_').toUpperCase()
  const value = Number(readArg(args, name) ?? env[envKey] ?? fallback)
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

export function readProcessWorkerOptions(input: ProcessWorkerOptionsInput): ProcessWorkerOptions {
  const interval = readNumber(input.args, input.env, '--interval-seconds', input.defaultIntervalSeconds)
  const limit = readNumber(input.args, input.env, '--limit', input.defaultLimit)
  const intervalSeconds = Math.max(5, interval)
  const leaseSeconds = readNumber(input.args, input.env, '--lease-seconds', intervalSeconds + 5)
  return {
    intervalSeconds,
    limit: Math.max(1, limit),
    dryRun: input.args.includes('--dry-run'),
    ownerId: readArg(input.args, '--owner-id') ?? input.env.DJBRAIN_PROCESS_OWNER_ID?.trim() ?? `${input.hostname}:${input.pid}`,
    priority: Math.max(0, readNumber(input.args, input.env, '--priority', 10)),
    takeover: input.args.includes('--takeover') || input.env.DJBRAIN_PROCESS_TAKEOVER === '1',
    leaseMs: Math.max(10, intervalSeconds + 5, leaseSeconds) * 1_000
  }
}

export function shouldRunServerStartupSync(env: Env): boolean {
  return readBoolean(env.DJBRAIN_ENABLE_SERVER_SYNC, false)
}

export type DogfoodFault = 'none' | 'driver-before-activation' | 'worker-after-checkpoint'

export interface DogfoodConfig {
  databaseUrl: string
  authToken?: string
  queue: string
  idempotencyKey: string
  repository: string
  ref: string
  cycles: number
  intervalSeconds: number
  leaseSeconds: number
  fault: DogfoodFault
}

type Environment = Readonly<Record<string, string | undefined>>

const DEFAULTS = {
  databaseUrl: 'file:dogfood.db',
  queue: 'dogfood',
  idempotencyKey: 'ref-journal-v1',
  repository: 'ejc3/durablerun',
  ref: 'main',
  cycles: 15,
  intervalSeconds: 12 * 60 * 60,
  leaseSeconds: 30,
  fault: 'none',
} as const

function nonempty(env: Environment, name: string, fallback: string): string {
  const value = env[name]?.trim()
  return value ? value : fallback
}

function nonnegativeInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new RangeError(`${name} must be a canonical nonnegative integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} is too large`)
  return value
}

export function dogfoodConfigFromEnv(env: Environment = process.env): DogfoodConfig {
  const cycles = nonnegativeInteger(env, 'DURABLERUN_DOGFOOD_CYCLES', DEFAULTS.cycles)
  if (cycles < 1) throw new RangeError('DURABLERUN_DOGFOOD_CYCLES must be at least 1')
  const authToken = env.TURSO_AUTH_TOKEN?.trim()
  const fault = nonempty(env, 'DURABLERUN_DOGFOOD_FAULT', DEFAULTS.fault)
  if (
    fault !== 'none' &&
    fault !== 'driver-before-activation' &&
    fault !== 'worker-after-checkpoint'
  ) {
    throw new RangeError('DURABLERUN_DOGFOOD_FAULT is not a supported fault')
  }
  const leaseSeconds = nonnegativeInteger(
    env,
    'DURABLERUN_DOGFOOD_LEASE_SECONDS',
    DEFAULTS.leaseSeconds,
  )
  if (leaseSeconds < 1) {
    throw new RangeError('DURABLERUN_DOGFOOD_LEASE_SECONDS must be at least 1')
  }
  return {
    databaseUrl: nonempty(env, 'TURSO_DATABASE_URL', DEFAULTS.databaseUrl),
    ...(authToken ? { authToken } : {}),
    queue: nonempty(env, 'DURABLERUN_DOGFOOD_QUEUE', DEFAULTS.queue),
    idempotencyKey: nonempty(env, 'DURABLERUN_DOGFOOD_KEY', DEFAULTS.idempotencyKey),
    repository: nonempty(env, 'DURABLERUN_DOGFOOD_REPOSITORY', DEFAULTS.repository),
    ref: nonempty(env, 'DURABLERUN_DOGFOOD_REF', DEFAULTS.ref),
    cycles,
    intervalSeconds: nonnegativeInteger(
      env,
      'DURABLERUN_DOGFOOD_INTERVAL_SECONDS',
      DEFAULTS.intervalSeconds,
    ),
    leaseSeconds,
    fault,
  }
}

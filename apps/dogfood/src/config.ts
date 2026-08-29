export interface DogfoodConfig {
  databaseUrl: string
  authToken?: string
  queue: string
  idempotencyKey: string
  repository: string
  ref: string
  cycles: number
  intervalSeconds: number
}

type Environment = Readonly<Record<string, string | undefined>>

const DEFAULTS = {
  databaseUrl: 'file:dogfood.db',
  queue: 'dogfood',
  idempotencyKey: 'repo-health-v1',
  repository: 'ejc3/durablerun',
  ref: 'main',
  cycles: 15,
  intervalSeconds: 12 * 60 * 60,
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
  }
}

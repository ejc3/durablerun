import { TASK_INTRINSICS } from './intrinsics.js'
import type { NormalizedRetryStrategy, RetryStrategy } from './types.js'
import { durationToMs, requirePositiveInt } from './validate.js'

const {
  MathMin: min,
  NumberIsFinite: isFiniteNumber,
  ObjectFreeze: freeze,
  RangeError: TrustedRangeError,
  ReflectGet: reflectGet,
} = TASK_INTRINSICS

/**
 * Retry math, ported from Absurd's fail_run (absurd.sql): exponential delay =
 * base * factor^(attempt-1), capped; the attempt that just failed is
 * `attempt`, and the task exhausts when the NEXT attempt would exceed
 * maxAttempts. Pure — the caller turns delaySeconds into available_at using
 * engine (database) time, never a JS clock (DESIGN.md §3.4 rule 3).
 */
export type RetryDecision = { retry: true; delaySeconds: number } | { retry: false }

export function decideRetry(
  strategy: RetryStrategy,
  failedAttempt: number,
  maxAttempts: number,
): RetryDecision {
  const normalizedDecision = normalizeRetryStrategy(strategy)
  const attempt = requirePositiveInt('failedAttempt', failedAttempt)
  const maximum = requirePositiveInt('maxAttempts', maxAttempts)
  if (normalizedDecision.kind === 'none' || attempt + 1 > maximum) return { retry: false }
  return {
    retry: true,
    delaySeconds: normalizedRetryDelaySeconds(normalizedDecision, attempt),
  }
}

export function retryDelaySeconds(
  strategy: Exclude<RetryStrategy, { kind: 'none' }>,
  failedAttempt: number,
): number {
  const normalizedDelay = normalizeRetryStrategy(strategy)
  if (normalizedDelay.kind === 'none') {
    throw new TrustedRangeError('retry delay requires a fixed or exponential strategy')
  }
  return normalizedRetryDelaySeconds(
    normalizedDelay,
    requirePositiveInt('failedAttempt', failedAttempt),
  )
}

function normalizedRetryDelaySeconds(
  strategy: Exclude<NormalizedRetryStrategy, { kind: 'none' }>,
  failedAttempt: number,
): number {
  let delay: number
  switch (strategy.kind) {
    case 'fixed':
      delay = strategy.baseSeconds
      break
    case 'exponential':
      if (strategy.baseSeconds === 0) return 0
      delay = strategy.baseSeconds * strategy.factor ** (failedAttempt - 1)
      if (!isFiniteNumber(delay)) delay = strategy.maxSeconds
      else delay = min(delay, strategy.maxSeconds)
      break
  }
  // The strategy fields are already millisecond-canonical, but multiplication
  // by a fractional factor can produce a sub-millisecond result. Return the
  // exact seconds value the store will persist, not a second representation.
  return durationToMs('retry delay', delay) / 1000
}

/**
 * The one retry-strategy parser and constructor. Callers include JavaScript
 * and durable JSON, so the input is unknown despite the public TypeScript
 * surface. Every field is snapshotted once, durations are canonicalized to
 * milliseconds, and a fresh exact frozen object crosses the serialization
 * boundary; caller getters, extra fields, and toJSON hooks never do.
 */
export function normalizeRetryStrategy(value: unknown): NormalizedRetryStrategy {
  if (typeof value !== 'object' || value === null) {
    throw new TrustedRangeError('retry strategy must be an object')
  }

  const kind = readRetryField(value, 'kind')

  if (kind === 'none') {
    return finalizeRetryStrategy({ kind: 'none' })
  }
  if (kind !== 'fixed' && kind !== 'exponential') {
    throw new TrustedRangeError('retry strategy kind must be none, fixed, or exponential')
  }

  const baseSeconds = readRetryField(value, 'baseSeconds')
  const canonicalBase = canonicalDurationSeconds('retry strategy baseSeconds', baseSeconds)

  if (kind === 'fixed') {
    return finalizeRetryStrategy({
      kind: 'fixed',
      baseSeconds: canonicalBase,
    })
  }

  const factor = readRetryField(value, 'factor')
  const maxSeconds = readRetryField(value, 'maxSeconds')
  const canonicalFactor = canonicalRetryFactor(factor)

  return finalizeRetryStrategy({
    kind: 'exponential',
    baseSeconds: canonicalBase,
    factor: canonicalFactor,
    maxSeconds: canonicalDurationSeconds('retry strategy maxSeconds', maxSeconds),
  })
}

function readRetryField(value: object, field: string): unknown {
  try {
    return reflectGet(value, field)
  } catch {
    throw new TrustedRangeError(`retry strategy ${field} is not readable`)
  }
}

function finalizeRetryStrategy(value: RetryStrategy): NormalizedRetryStrategy {
  return freeze(value) as NormalizedRetryStrategy
}

function canonicalDurationSeconds(name: string, value: unknown): number {
  if (typeof value !== 'number') {
    throw new TrustedRangeError(`${name} must be a number`)
  }
  const milliseconds = durationToMs(name, value)
  return milliseconds === 0 ? 0 : milliseconds / 1000
}

function canonicalRetryFactor(value: unknown): number {
  if (typeof value !== 'number' || !isFiniteNumber(value) || value < 0) {
    throw new TrustedRangeError('retry strategy factor must be a finite non-negative number')
  }
  return value === 0 ? 0 : value
}

/** The retry strategy `spawn` stores for a task that names none, on every dialect. */
export const DEFAULT_RETRY = normalizeRetryStrategy({
  kind: 'exponential',
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 3600,
})
/** The attempt budget `spawn` stores for a task that names none, on every dialect. */
export const DEFAULT_MAX_ATTEMPTS = 5

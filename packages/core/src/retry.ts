import type { RetryStrategy } from './types.js'

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
  if (failedAttempt < 1) throw new RangeError(`failedAttempt must be >= 1, got ${failedAttempt}`)
  if (strategy.kind === 'none') return { retry: false }
  if (failedAttempt + 1 > maxAttempts) return { retry: false }
  return { retry: true, delaySeconds: retryDelaySeconds(strategy, failedAttempt) }
}

export function retryDelaySeconds(
  strategy: Exclude<RetryStrategy, { kind: 'none' }>,
  failedAttempt: number,
): number {
  let delay: number
  switch (strategy.kind) {
    case 'fixed':
      delay = strategy.baseSeconds
      break
    case 'exponential':
      delay = Math.min(
        strategy.baseSeconds * strategy.factor ** (failedAttempt - 1),
        strategy.maxSeconds,
      )
      break
  }
  // Malformed strategies round-trip through a TEXT column; NaN here would
  // store a garbage available_at and silently lose the run forever — worse
  // than a crash. Fail loudly instead (spawn also validates, see
  // normalizeRetryStrategy).
  if (!Number.isFinite(delay)) {
    throw new RangeError(`retry delay is not finite for strategy ${JSON.stringify(strategy)}`)
  }
  return Math.max(0, delay)
}

/**
 * Validates a strategy at the write boundary (spawn) so malformed data never
 * reaches the retry_strategy column. Returns the value unchanged on success.
 */
export function normalizeRetryStrategy(strategy: RetryStrategy): RetryStrategy {
  if (strategy.kind === 'none') return strategy
  const finitePositive = (n: unknown): boolean =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!finitePositive(strategy.baseSeconds)) {
    throw new RangeError(`retry strategy baseSeconds invalid: ${JSON.stringify(strategy)}`)
  }
  if (strategy.kind === 'exponential') {
    if (!finitePositive(strategy.factor) || !finitePositive(strategy.maxSeconds)) {
      throw new RangeError(`retry strategy factor/maxSeconds invalid: ${JSON.stringify(strategy)}`)
    }
  }
  return strategy
}

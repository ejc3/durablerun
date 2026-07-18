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
  switch (strategy.kind) {
    case 'fixed':
      return strategy.baseSeconds
    case 'exponential':
      return Math.min(
        strategy.baseSeconds * strategy.factor ** (failedAttempt - 1),
        strategy.maxSeconds,
      )
  }
}

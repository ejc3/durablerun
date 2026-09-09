import { FatalTaskError } from '@durablerun/core'
import type { TaskContext } from '@durablerun/sdk'

export const PR_WATCHER_TASK = 'watch-pr-checks'
export const PR_WATCHER_OBSERVATION_STEP = 'github-checks'

export type PrCheckSelector =
  | { kind: 'check-run'; name: string; appId: number }
  | { kind: 'status'; name: string }

export interface PrWatchInput {
  repository: string
  pullNumber: number
  headSha: string
  checks: PrCheckSelector[]
  maxPolls: number
  intervalSeconds: number
}

export type PrCheckObservation = PrCheckSelector & { state: 'pending' | 'passed' | 'failed' }

export type PrWatchObservation =
  | {
      kind: 'observed'
      observedAt: string
      headSha: string
      state: 'open' | 'closed'
      checks: PrCheckObservation[]
    }
  | {
      kind: 'unavailable'
      observedAt: string
      retryable: boolean
      reason: string
      retryAfterSeconds?: number
    }

export type PrWatchObserver = (input: PrWatchInput) => Promise<PrWatchObservation>

export interface PrWatchResult {
  status: 'ready' | 'failed' | 'superseded' | 'closed' | 'timed-out' | 'unavailable'
  repository: string
  pullNumber: number
  headSha: string
  polls: number
  latest: PrWatchObservation
  attempt: number
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FatalTaskError('watch-pr-checks parameters and selectors must be objects')
  }
  return value as Record<string, unknown>
}

function integer(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new FatalTaskError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function parsePrWatchInput(params: unknown): PrWatchInput {
  const value = object(params)
  if (
    typeof value.repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repository) ||
    ['.', '..'].includes(value.repository.split('/')[1] ?? '')
  ) {
    throw new FatalTaskError('repository must be owner/name')
  }
  if (typeof value.headSha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(value.headSha)) {
    throw new FatalTaskError('headSha must be a full 40-character commit SHA')
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    throw new FatalTaskError('checks must contain at least one explicit selector')
  }
  const checks = value.checks.map((raw): PrCheckSelector => {
    const selector = object(raw)
    if (typeof selector.name !== 'string' || selector.name.trim().length === 0) {
      throw new FatalTaskError('check names must be non-empty strings')
    }
    if (selector.kind === 'status') return { kind: 'status', name: selector.name.toLowerCase() }
    if (selector.kind === 'check-run') {
      return {
        kind: 'check-run',
        name: selector.name,
        appId: integer('appId', selector.appId, 1, Number.MAX_SAFE_INTEGER),
      }
    }
    throw new FatalTaskError('check kind must be check-run or status')
  })
  if (new Set(checks.map((selector) => JSON.stringify(selector))).size !== checks.length) {
    throw new FatalTaskError('check selectors must be unique')
  }
  return {
    repository: value.repository,
    pullNumber: integer('pullNumber', value.pullNumber, 1, Number.MAX_SAFE_INTEGER),
    headSha: value.headSha.toLowerCase(),
    checks,
    maxPolls: integer('maxPolls', value.maxPolls === undefined ? 10 : value.maxPolls, 1, 30),
    intervalSeconds: integer(
      'intervalSeconds',
      value.intervalSeconds === undefined ? 60 : value.intervalSeconds,
      60,
      3_600,
    ),
  }
}

function selectedStates(input: PrWatchInput, observed: PrCheckObservation[]) {
  return input.checks.map((selector) => {
    const matches = observed.filter(
      (check) =>
        check.kind === selector.kind &&
        check.name === selector.name &&
        (selector.kind !== 'check-run' ||
          (check.kind === 'check-run' && check.appId === selector.appId)),
    )
    // Missing or ambiguous producers never establish success.
    return matches.length === 1 ? matches[0]?.state : 'pending'
  })
}

export function createPrWatcher(
  observe: PrWatchObserver,
): (ctx: TaskContext, params: unknown) => Promise<PrWatchResult> {
  return async (ctx, params) => {
    const input = parsePrWatchInput(params)
    let unavailableStreak = 0
    for (let polls = 1; ; polls++) {
      // Only the read is inside the step. SDK suspension and lease-loss
      // controls must escape unchanged, never become GitHub error results.
      const latest = await ctx.step(PR_WATCHER_OBSERVATION_STEP, () => observe(input))
      unavailableStreak = latest.kind === 'unavailable' ? unavailableStreak + 1 : 0
      let status: PrWatchResult['status'] | undefined
      if (latest.kind === 'unavailable') {
        if (!latest.retryable) status = 'unavailable'
      } else if (latest.headSha !== input.headSha) {
        status = 'superseded'
      } else if (latest.state !== 'open') {
        status = 'closed'
      } else {
        const states = selectedStates(input, latest.checks)
        if (states.includes('failed')) status = 'failed'
        else if (states.every((state) => state === 'passed')) status = 'ready'
      }
      if (status === undefined && polls === input.maxPolls) {
        status = latest.kind === 'unavailable' ? 'unavailable' : 'timed-out'
      }
      if (status !== undefined) {
        return {
          status,
          repository: input.repository,
          pullNumber: input.pullNumber,
          headSha: input.headSha,
          polls,
          latest,
          attempt: ctx.attempt,
        }
      }
      const delay =
        latest.kind === 'unavailable'
          ? Math.max(
              latest.retryAfterSeconds ?? 0,
              Math.min(3_600, input.intervalSeconds * 2 ** (unavailableStreak - 1)),
            )
          : input.intervalSeconds
      await ctx.sleepFor(delay)
    }
  }
}

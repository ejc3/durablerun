import type { ClaimedRun } from '@durablerun/core'

/**
 * The shape this worker requires of each `ClaimedRun` field an activation answers.
 * A worker can run against a store built from another commit, so the answer is
 * checked before any user code runs, and `satisfies` makes a new field a type error
 * until it is classified. `optional` fields may be absent, and `unread` fields are
 * never read by this worker.
 */
export const CLAIMED_RUN_ANSWER_FIELDS = {
  runId: 'string',
  claimToken: 'string',
  taskId: 'string',
  taskName: 'string',
  attempt: 'count',
  infraRetries: 'count',
  claimGen: 'count',
  claimExpiresAtEpochMs: 'unread',
  leaseSeconds: 'positive',
  paramsJson: 'string',
  retryStrategy: 'object',
  maxAttempts: 'count',
  headers: 'unread',
  wake: 'optional',
} as const satisfies Record<
  keyof ClaimedRun,
  'string' | 'count' | 'positive' | 'object' | 'optional' | 'unread'
>

/** The first required field an activation answer is missing or has malformed, if any. */
export function claimedRunAnswerProblem(run: ClaimedRun): string | undefined {
  const answer = run as unknown as Record<string, unknown>
  for (const [field, shape] of Object.entries(CLAIMED_RUN_ANSWER_FIELDS)) {
    const value = answer[field]
    const admissible =
      shape === 'optional' || shape === 'unread'
        ? true
        : shape === 'string'
          ? typeof value === 'string'
          : shape === 'count'
            ? Number.isSafeInteger(value) && (value as number) >= 0
            : shape === 'positive'
              ? typeof value === 'number' && Number.isFinite(value) && value > 0
              : typeof value === 'object' && value !== null
    if (!admissible) return field
  }
  return undefined
}

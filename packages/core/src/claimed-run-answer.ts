import { normalizeRetryStrategy } from './retry.js'
import type { ClaimedRun } from './types.js'
import {
  type IntegerBounds,
  PERSISTED_INTEGER_BOUNDS,
  POSITIVE_CLAIM_GENERATION_BOUNDS,
  decodeBoundedInteger,
} from './validate.js'

/**
 * How a worker treats each field of an activation answer. A worker can run against a
 * store built from another commit, so every field it reads is checked before any user
 * code runs, and `satisfies` makes a new `ClaimedRun` field a type error until it is
 * classified. A `checked` field must be present and well formed, an `optional` field
 * may be absent but is checked when present, and an `unread` field is never read.
 */
export const CLAIMED_RUN_ANSWER_FIELDS = {
  runId: 'checked',
  claimToken: 'checked',
  taskId: 'checked',
  taskName: 'checked',
  attempt: 'checked',
  infraRetries: 'checked',
  claimGen: 'checked',
  claimExpiresAtEpochMs: 'unread',
  leaseSeconds: 'checked',
  paramsJson: 'checked',
  retryStrategy: 'checked',
  maxAttempts: 'checked',
  headers: 'unread',
  wake: 'optional',
} as const satisfies Record<keyof ClaimedRun, 'checked' | 'optional' | 'unread'>

type ReadField = {
  [Field in keyof typeof CLAIMED_RUN_ANSWER_FIELDS]: (typeof CLAIMED_RUN_ANSWER_FIELDS)[Field] extends 'unread'
    ? never
    : Field
}[keyof typeof CLAIMED_RUN_ANSWER_FIELDS]

type AnswerCheck = (value: unknown) => boolean

const nonEmptyText: AnswerCheck = (value) => typeof value === 'string' && value.length > 0
const bounded =
  (bounds: IntegerBounds): AnswerCheck =>
  (value) =>
    decodeBoundedInteger(value, bounds).ok

/** The stores' own bounds for each read field, so the check is not a weaker second copy. */
const CLAIMED_RUN_ANSWER_CHECKS = {
  runId: nonEmptyText,
  claimToken: nonEmptyText,
  taskId: nonEmptyText,
  taskName: nonEmptyText,
  attempt: bounded(PERSISTED_INTEGER_BOUNDS.runs.attempt),
  infraRetries: bounded(PERSISTED_INTEGER_BOUNDS.tasks.infra_retries),
  claimGen: bounded(POSITIVE_CLAIM_GENERATION_BOUNDS),
  leaseSeconds: (value) =>
    typeof value === 'number' &&
    decodeBoundedInteger(value * 1000, PERSISTED_INTEGER_BOUNDS.runs.lease_ms).ok,
  paramsJson: (value) => typeof value === 'string',
  retryStrategy: (value) => {
    try {
      normalizeRetryStrategy(value)
      return true
    } catch {
      return false
    }
  },
  maxAttempts: bounded(PERSISTED_INTEGER_BOUNDS.tasks.max_attempts),
  wake: (value) => {
    if (value === undefined) return true
    if (typeof value !== 'object' || value === null) return false
    const wake = value as Record<string, unknown>
    if (!nonEmptyText(wake.event) || !nonEmptyText(wake.step)) return false
    return wake.timedOut === true
      ? wake.payloadJson === undefined
      : typeof wake.payloadJson === 'string' && wake.timedOut === undefined
  },
} satisfies Record<ReadField, AnswerCheck>

const CLAIMED_RUN_ANSWER_CHECK_ENTRIES = Object.entries(CLAIMED_RUN_ANSWER_CHECKS)

/** The first field this worker reads that an activation answer lacks or has malformed. */
export function claimedRunAnswerProblem(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null) return 'answer'
  const fields = answer as Record<string, unknown>
  for (const [field, check] of CLAIMED_RUN_ANSWER_CHECK_ENTRIES) {
    if (!check(fields[field])) return field
  }
  return undefined
}

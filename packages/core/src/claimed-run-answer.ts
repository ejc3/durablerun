import { TASK_INTRINSICS } from './intrinsics.js'
import { normalizeRetryStrategy } from './retry.js'
import type { ClaimedRun, EventWake } from './types.js'
import {
  type IntegerBounds,
  PERSISTED_INTEGER_BOUNDS,
  POSITIVE_CLAIM_GENERATION_BOUNDS,
  decodeBoundedInteger,
} from './validate.js'

/** How an answer surface treats a field: must be well formed, may be absent, or never read. */
export type AnswerFieldRole = 'checked' | 'optional' | 'unread'

type Decoded<T> = { ok: true; value: T } | { ok: false }
type Decoder<T> = (value: unknown) => Decoded<T>
type FieldRule<T> = { role: 'checked' | 'optional'; decode: Decoder<T> }

const REFUSED = { ok: false } as const
const accept = <T>(value: T): Decoded<T> => ({ ok: true, value })

const nonEmptyText: Decoder<string> = (value) =>
  typeof value === 'string' && value.length > 0 ? accept(value) : REFUSED
const bounded =
  (bounds: IntegerBounds): Decoder<number> =>
  (value) =>
    typeof value === 'number' && decodeBoundedInteger(value, bounds).ok ? accept(value) : REFUSED
const checked = <T>(decode: Decoder<T>): FieldRule<T> => ({ role: 'checked', decode })
const optional = <T>(decode: Decoder<T>): FieldRule<T> => ({ role: 'optional', decode })

/** The stores answer `lease_ms / 1000`, so decode through whole milliseconds, as they do. */
const leaseSeconds: Decoder<number> = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return REFUSED
  const leaseMs = Math.round(value * 1000)
  if (Math.abs(value * 1000 - leaseMs) > 1e-6 * Math.max(1, leaseMs)) return REFUSED
  return decodeBoundedInteger(leaseMs, PERSISTED_INTEGER_BOUNDS.runs.lease_ms).ok
    ? accept(leaseMs / 1000)
    : REFUSED
}

const eventWake: Decoder<EventWake> = (value) => {
  if (typeof value !== 'object' || value === null) return REFUSED
  const wake = value as Record<string, unknown>
  const own = (key: string) => TASK_INTRINSICS.ObjectHasOwn(wake, key)
  const event = nonEmptyText(wake.event)
  const step = nonEmptyText(wake.step)
  if (!event.ok || !step.ok) return REFUSED
  if (own('timedOut') && wake.timedOut === true) {
    return own('payloadJson')
      ? REFUSED
      : accept({ event: event.value, step: step.value, timedOut: true })
  }
  if (own('timedOut') && wake.timedOut !== false) return REFUSED
  return own('payloadJson') && typeof wake.payloadJson === 'string'
    ? accept({ event: event.value, step: step.value, payloadJson: wake.payloadJson })
    : REFUSED
}

/**
 * How a worker decodes each field of an activation answer. A worker can run against a
 * store built from another commit, so every field it reads is decoded with the stores'
 * own bounds before any user code runs, and `satisfies` makes a new `ClaimedRun` field a
 * type error until it is classified.
 */
const CLAIMED_RUN_ANSWER_RULES = {
  runId: checked(nonEmptyText),
  claimToken: checked(nonEmptyText),
  taskId: checked(nonEmptyText),
  taskName: checked(nonEmptyText),
  attempt: checked(bounded(PERSISTED_INTEGER_BOUNDS.runs.attempt)),
  infraRetries: checked(bounded(PERSISTED_INTEGER_BOUNDS.tasks.infra_retries)),
  claimGen: checked(bounded(POSITIVE_CLAIM_GENERATION_BOUNDS)),
  claimExpiresAtEpochMs: 'unread',
  leaseSeconds: checked(leaseSeconds),
  paramsJson: checked((value) => (typeof value === 'string' ? accept(value) : REFUSED)),
  retryStrategy: checked((value) => {
    try {
      return accept(normalizeRetryStrategy(value))
    } catch {
      return REFUSED
    }
  }),
  maxAttempts: checked(bounded(PERSISTED_INTEGER_BOUNDS.tasks.max_attempts)),
  headers: 'unread',
  wake: optional(eventWake),
} satisfies { [Field in keyof ClaimedRun]-?: FieldRule<ClaimedRun[Field]> | 'unread' }

type Rules = typeof CLAIMED_RUN_ANSWER_RULES

/** The activation answer fields a worker reads. */
export type ClaimedRunAnswerReadField = {
  [Field in keyof Rules]: Rules[Field] extends 'unread' ? never : Field
}[keyof Rules]

/** The run a worker executes: the fields it reads, decoded from the store's answer. */
export type WorkerClaimedRun = Pick<ClaimedRun, ClaimedRunAnswerReadField>

/** Each activation answer field's role, for surfaces that generate answers. */
export const CLAIMED_RUN_ANSWER_FIELDS = Object.fromEntries(
  Object.entries(CLAIMED_RUN_ANSWER_RULES).map(([field, rule]) => [
    field,
    rule === 'unread' ? 'unread' : rule.role,
  ]),
) as Record<keyof ClaimedRun, AnswerFieldRole>

const READ_RULES = Object.entries(CLAIMED_RUN_ANSWER_RULES).flatMap(([field, rule]) =>
  rule === 'unread' ? [] : [[field, rule as FieldRule<unknown>] as const],
)

export type ClaimedRunAnswerDecode =
  | { ok: true; run: WorkerClaimedRun }
  | { ok: false; field: ClaimedRunAnswerReadField | 'answer' }

/**
 * Decode an activation answer into the run this worker executes, or name the first
 * field it reads that is absent, malformed, or unreadable. The worker runs on the
 * decoded run, never on the answer itself.
 */
export function decodeClaimedRunAnswer(answer: unknown): ClaimedRunAnswerDecode {
  if (typeof answer !== 'object' || answer === null) return { ok: false, field: 'answer' }
  const fields = answer as Record<string, unknown>
  const run: Record<string, unknown> = {}
  for (const [field, rule] of READ_RULES) {
    const refused = { ok: false, field: field as ClaimedRunAnswerReadField } as const
    // Every read of the field, including nested accessors, happens inside the try.
    let decoded: { ok: true; value: unknown } | { ok: false } | 'absent'
    try {
      const value = fields[field]
      decoded = value === undefined && rule.role === 'optional' ? 'absent' : rule.decode(value)
    } catch {
      return refused
    }
    if (decoded === 'absent') continue
    if (!decoded.ok) return refused
    run[field] = decoded.value
  }
  const decoded = run as WorkerClaimedRun
  // The stores claim `attempt = attempts + infra_retries + 1`, so a user attempt is positive.
  if (decoded.infraRetries >= decoded.attempt) return { ok: false, field: 'infraRetries' }
  return { ok: true, run: decoded }
}

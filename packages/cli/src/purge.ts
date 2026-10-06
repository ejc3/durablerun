import {
  MIN_RETENTION_SECONDS,
  OPERATOR_LIST_CAP,
  PURGE_BARRIER_CONDITIONS,
  type PurgeAdmission,
  type PurgeBarrierCondition,
  type PurgeCandidate,
  type PurgeUnitTarget,
  type RetentionPolicy,
} from '@durablerun/core'
import { PURGE_DEFAULT_LIMIT, durationSeconds, wholeNumber } from './commands.js'
import { userValue } from './render.js'

/**
 * What `purge` says: how its flags become a retention policy, and how a unit and what the
 * barrier says of it print. Everything here is pure. The command deletes only through the
 * store's retention port, so nothing here decides whether a unit goes: the port's
 * compare-and-set does, and these functions read what it and the port's reads answered.
 */

/** The flag that names each window of a policy. `failed-after` is the one a purge may leave out. */
const WINDOW_FLAGS = [
  ['completed-after', 'completedSeconds'],
  ['cancelled-after', 'cancelledSeconds'],
  ['failed-after', 'failedSeconds'],
] as const satisfies readonly (readonly [string, keyof RetentionPolicy])[]

/**
 * The policy a command line names, or why it names none. A window is a duration as an
 * operator writes one, of at least the floor core holds a policy to. The port refuses a
 * window under that floor too. It is refused here first, by the flag's own name, before
 * anything is sent. The two required windows are required by the command table, so one
 * that is missing never reaches this.
 */
export function policyOf(
  strings: Readonly<Record<string, string>>,
): { readonly policy: RetentionPolicy } | { readonly refused: string } {
  const windows: { -readonly [Window in keyof RetentionPolicy]?: number } = {}
  for (const [flag, window] of WINDOW_FLAGS) {
    const text = strings[flag]
    if (text === undefined) continue
    const seconds = durationSeconds(text)
    if (seconds === null) {
      return {
        refused: `--${flag} takes a whole number and a unit, s, m, h or d, as in 12h or 2d, of at most 100 years`,
      }
    }
    if (seconds < MIN_RETENTION_SECONDS) {
      return {
        refused: `--${flag} must be at least ${MIN_RETENTION_SECONDS} seconds, as in 1h: no purge takes a task that ended less than an hour ago`,
      }
    }
    windows[window] = seconds
  }
  const { completedSeconds, cancelledSeconds, failedSeconds } = windows
  if (completedSeconds === undefined || cancelledSeconds === undefined) {
    return { refused: 'purge requires --completed-after and --cancelled-after' }
  }
  return {
    policy: {
      completedSeconds,
      cancelledSeconds,
      ...(failedSeconds === undefined ? {} : { failedSeconds }),
    },
  }
}

/** A policy as the command prints it: every window, and null for the failed window it does not name. */
export const policyView = (policy: RetentionPolicy): Record<string, number | null> => ({
  completedSeconds: policy.completedSeconds,
  cancelledSeconds: policy.cancelledSeconds,
  failedSeconds: policy.failedSeconds ?? null,
})

/**
 * The most units one invocation takes, from `--limit`, or why the flag cannot be read. A
 * command line that names none takes the default.
 */
export function limitOf(
  text: string | undefined,
): { readonly limit: number } | { readonly refused: string } {
  if (text === undefined) return { limit: PURGE_DEFAULT_LIMIT }
  const limit = wholeNumber(text, OPERATOR_LIST_CAP)
  if (limit === null) {
    return { refused: `--limit takes a whole number from 1 to ${OPERATOR_LIST_CAP}` }
  }
  return { limit }
}

/** What names a candidate's unit to the port: its task, and the key it was listed under. */
export const unitOf = (candidate: PurgeCandidate): PurgeUnitTarget =>
  candidate.idempotencyKey === undefined
    ? { taskId: candidate.taskId }
    : { taskId: candidate.taskId, idempotencyKey: candidate.idempotencyKey }

/**
 * A unit as the command prints it: its task's id and name, the state it ended in, the
 * instant it ended, and the sha256 of the idempotency key it was spawned under. The key is
 * a value a user wrote, and a purged task's key is free to be used again, so only its
 * digest prints, with `--reveal` or without: a report of what was deleted is kept, and
 * the digest is what finds a unit in it by its key.
 */
export function unitView(candidate: PurgeCandidate): Record<string, unknown> {
  return {
    taskId: candidate.taskId,
    taskName: candidate.taskName,
    state: candidate.state,
    endedAtMs: candidate.endedAtMs,
    idempotencyKeySha256:
      candidate.idempotencyKey === undefined
        ? null
        : userValue(candidate.idempotencyKey, false).sha256,
  }
}

/** Why the barrier keeps a unit, as the command names it. */
export const KEPT_REASONS = [
  'not-ended-a-window-ago',
  'unstamped',
  'live-run',
  'outcome-held',
  'awaited',
  'parent-can-run-again',
  'key-changed',
  'run-in-another-queue',
  'oversized',
] as const
export type KeptReason = (typeof KEPT_REASONS)[number]

/**
 * The reason each condition of the barrier gives when it is false. It is keyed by core's
 * list of the barrier's conditions, so a condition the barrier gains stops the build until
 * it has a reason here.
 */
export const REASON_OF_CONDITION: Readonly<Record<PurgeBarrierCondition, KeptReason>> = {
  endedAWindowAgo: 'not-ended-a-window-ago',
  stampInRange: 'unstamped',
  noLiveRun: 'live-run',
  noRunHoldsTheOutcome: 'outcome-held',
  noWaitOnTheOutcome: 'awaited',
  parentCannotRunAgain: 'parent-can-run-again',
  spawnedUnderThisKey: 'key-changed',
  ownsEveryRun: 'run-in-another-queue',
  withinTheCheckpointCap: 'oversized',
}

export const REASON_SAYS: Readonly<Record<KeptReason, string>> = {
  'not-ended-a-window-ago':
    "the task is not in a state the policy names, ended at least that state's window ago: it was revived, or its age is under the window",
  unstamped:
    'the instant the task ended is not a stored instant in range, so its age cannot be read',
  'live-run': 'a run of the task is live, though the task has ended, which no engine path writes',
  'outcome-held':
    "a run of another task holds the task's outcome, so a claim of that run still reads it",
  awaited: "a wait names the task's completion event, which an older build left",
  'parent-can-run-again':
    'the task that spawned it is live or failed, and its replay would spawn a second child, or its key names no parent that can be read',
  'key-changed': 'the task is not spawned under the key it was listed under',
  'run-in-another-queue': 'a run of the task is in another queue, which no engine path writes',
  oversized: 'the unit holds more checkpoints than one batch may delete',
}

/**
 * What the barrier says of a unit it keeps, from the read of each of its conditions: the
 * false ones, and the reason each gives. The read is of the unit as of that read. When
 * every condition holds, nothing keeps the unit as of the read, and the answer says so
 * and names no reason: a purge that the port answered kept ran a moment before it, and the
 * unit changed in between.
 */
export function keptView(
  candidate: PurgeCandidate,
  admission: PurgeAdmission,
): Record<string, unknown> {
  const conditionsNotHeld = PURGE_BARRIER_CONDITIONS.filter(
    (condition) => !admission.holds[condition],
  )
  const reasons = [...new Set(conditionsNotHeld.map((condition) => REASON_OF_CONDITION[condition]))]
  return {
    ...unitView(candidate),
    reasons: reasons.length === 0 ? ['none-as-of-this-read'] : reasons,
    conditionsNotHeld,
  }
}

/** Whether every condition of the barrier holds of a unit, as of the read. */
export const letsGo = (admission: PurgeAdmission): boolean =>
  PURGE_BARRIER_CONDITIONS.every((condition) => admission.holds[condition])

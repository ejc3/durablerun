import {
  MAX_EPOCH_MS,
  MIN_RETENTION_SECONDS,
  OPERATOR_LIST_CAP,
  PURGE_BARRIER_CONDITIONS,
  type PurgeAdmission,
  type PurgeBarrierCondition,
  type PurgeCandidate,
  type PurgeCursor,
  type RetentionPolicy,
  requireDurableString,
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

/**
 * A place in a queue's candidates as the command prints it and takes it back: the instant
 * its task ended, a colon, and the task's id. An id is minted by the engine and is no value
 * a user wrote.
 */
export const cursorText = (cursor: PurgeCursor): string => `${cursor.endedAtMs}:${cursor.taskId}`

/**
 * The place `--after` names, or why the flag cannot be read. It is refused here, before
 * anything is sent, and the refusal does not quote it.
 */
export function cursorOf(
  text: string | undefined,
): { readonly after: PurgeCursor | null } | { readonly refused: string } {
  if (text === undefined) return { after: null }
  const refused = {
    refused:
      '--after takes the place an earlier purge printed as resumeAfter: an instant and a task id joined by a colon',
  }
  const colon = text.indexOf(':')
  if (colon < 1 || !/^(0|[1-9][0-9]{0,15})$/.test(text.slice(0, colon))) return refused
  const endedAtMs = Number(text.slice(0, colon))
  const taskId = text.slice(colon + 1)
  if (endedAtMs > MAX_EPOCH_MS || taskId === '') return refused
  try {
    requireDurableString('taskId', taskId)
  } catch {
    return refused
  }
  return { after: { endedAtMs, taskId } }
}

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

/**
 * Why the barrier keeps a unit, as the command names it: the reason each condition of the
 * barrier gives when it is false. It is keyed by core's list of the barrier's conditions,
 * so a condition the barrier gains stops the build until it has a reason here.
 */
export const REASON_OF_CONDITION = {
  endedAWindowAgo: 'not-ended-a-window-ago',
  stampInRange: 'unstamped',
  noLiveRun: 'live-run',
  noRunHoldsTheOutcome: 'outcome-held',
  noWaitOnTheOutcome: 'awaited',
  parentCannotRunAgain: 'parent-can-run-again',
  spawnedUnderThisKey: 'key-changed',
  ownsEveryRun: 'run-in-another-queue',
  withinTheCheckpointCap: 'oversized',
} as const satisfies Readonly<Record<PurgeBarrierCondition, string>>

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
  const reasons: string[] = conditionsNotHeld.map((condition) => REASON_OF_CONDITION[condition])
  return {
    ...unitView(candidate),
    reasons: reasons.length === 0 ? ['none-as-of-this-read'] : reasons,
    conditionsNotHeld,
  }
}

import {
  RETRY_GUARD,
  type RetryGuardConjunct,
  type TaskAdmission,
  type TaskFacts,
  isPortRefusal,
  parseTaskValueJson,
  refuseReservedEventName,
  serializeTaskValue,
} from '@durablerun/core'
import { stateView } from './inspect.js'

/**
 * What the drive verbs say about a write: how an argument becomes the JSON a port is
 * handed, and how a refusal is named. Everything here is pure. Each verb is one call of
 * the store's port and nothing else, so nothing here decides whether a write happens: the
 * port does, and these functions read what it left.
 */

/**
 * A JSON argument as the port is handed it: parsed and written again by the two functions
 * the hosted routes hand a store's port its JSON through, so a task enqueued here holds
 * the bytes the same parameters hold when they are enqueued over HTTP. No value is `null`,
 * as it is there. Text that is not one JSON value is refused, and the refusal does not
 * quote it: the text is a value a user wrote.
 */
export function jsonArgument(
  text: string | undefined,
): { readonly json: string } | { readonly refused: string } {
  try {
    // The label is for a message this function never lets out: its refusal says nothing of the text.
    const value = text === undefined ? null : parseTaskValueJson(text)
    return { json: serializeTaskValue('a JSON argument', value) }
  } catch {
    return { refused: 'takes one JSON value, as in {"a":1}. What it was given is not printed' }
  }
}

/** Whether an event name is the engine's own, by core's own refusal of it at the store's port. */
export function isReservedEventName(eventName: string): boolean {
  try {
    refuseReservedEventName('emit', eventName)
    return false
  } catch (error) {
    if (isPortRefusal(error)) return true
    throw error
  }
}

/** Why a revival is refused, apart from a task that is not there, which is the tenth cause. */
export const RETRY_CAUSES = [
  'not-failed',
  'run-in-another-queue',
  'no-failure-reason',
  'completed-payload',
  'no-run',
  'live-run',
  'counter-out-of-range',
  'out-of-accounting',
  'saga-began',
] as const
export type RetryCause = (typeof RETRY_CAUSES)[number]

/**
 * The cause each conjunct of the retry guard gives when it is false. It is keyed by core's
 * list of the guard's conjuncts, so a conjunct the guard gains stops the build until it
 * has a cause here. Four conjuncts hold a counter to its range and two hold the charge to
 * the task's accounting, so nine causes name thirteen conjuncts.
 */
export const CAUSE_OF_CONJUNCT: Readonly<Record<RetryGuardConjunct, RetryCause>> = {
  failed: 'not-failed',
  ownsEveryRun: 'run-in-another-queue',
  hasAFailureReason: 'no-failure-reason',
  hasNoCompletedPayload: 'completed-payload',
  hasARun: 'no-run',
  hasNoLiveRun: 'live-run',
  attemptsInRange: 'counter-out-of-range',
  infraRetriesInRange: 'counter-out-of-range',
  everyRunOrdinalInRange: 'counter-out-of-range',
  budgetTakesOneMore: 'counter-out-of-range',
  chargeIsTheAttemptsOrOneMore: 'out-of-accounting',
  sagaNotBegun: 'saga-began',
  chargeWithinBudget: 'out-of-accounting',
}

const CAUSE_SAYS: Readonly<Record<RetryCause, string>> = {
  'not-failed': 'the task is not failed, and only a failed task is revived',
  'run-in-another-queue': 'one of the runs that name the task is in another queue',
  'no-failure-reason': 'the failed task holds no failure reason, which no engine path writes',
  'completed-payload': 'the failed task holds a completed payload, which no engine path writes',
  'no-run': 'the task has no run of its own',
  'live-run': 'the task has a live run',
  'counter-out-of-range':
    "a counter of the task or the ordinal of one of its runs is outside its range, or the task's budget cannot take one more attempt",
  'out-of-accounting':
    "the task's attempts and infrastructure retries do not account for its top run, or the charge is past its budget",
  'saga-began':
    'the saga of the task began, and a task whose steps were rolled back is not revived (DESIGN.md section 3.10)',
}

export interface RetryRefusal {
  /** The first cause, in the order the guard holds its conjuncts, or what the read found when every conjunct holds. */
  readonly cause: RetryCause | 'none-as-of-this-read'
  /** Every cause, each once, in that order. */
  readonly causes: readonly RetryCause[]
  /** Every conjunct of the guard that is false, by core's name for it. */
  readonly conjunctsNotHeld: readonly RetryGuardConjunct[]
  readonly message: string
}

/**
 * Why the retry guard refuses a task, from the read of each of its conjuncts: the false
 * ones, and the cause each gives. The read is of the task after the refusal, so the cause
 * is the one that stands as of that read. When every conjunct holds, the task changed
 * between the call and the read, and the answer says so and names no cause.
 */
export function retryRefusal(taskId: string, admission: TaskAdmission): RetryRefusal {
  const conjunctsNotHeld = RETRY_GUARD.filter((name) => !admission.retry[name])
  const causes = [...new Set(conjunctsNotHeld.map((name) => CAUSE_OF_CONJUNCT[name]))]
  const [cause] = causes
  if (cause === undefined) {
    return {
      cause: 'none-as-of-this-read',
      causes,
      conjunctsNotHeld,
      message: `retry of task ${taskId} was refused, and every conjunct of the retry guard holds as of this read: the task changed between the call and the read. Run it again. Nothing was changed`,
    }
  }
  return {
    cause,
    causes,
    conjunctsNotHeld,
    message: `retry of task ${taskId} was refused. As of this read: ${causes.map((one) => CAUSE_SAYS[one]).join('; ')}. Nothing was changed`,
  }
}

/** The runs that name a task and stand in another queue, by which a cancellation of the task is refused. */
export const runsInAnotherQueue = (queue: string, facts: TaskFacts): string[] =>
  facts.runs.filter((run) => run.queue !== queue).map((run) => run.runId)

/**
 * What `cancel` prints of a task whose saga began, before it halts the rollback: the
 * counters and every run, the rollback passes among them. A stored state that is not the
 * engine's own prints hidden, as it does everywhere.
 */
export const rollbackFacts = (facts: TaskFacts, reveal: boolean): Record<string, unknown> => ({
  attempts: facts.task.attempts,
  maxAttempts: facts.task.maxAttempts,
  runs: facts.runs.map((run) => ({
    runId: run.runId,
    attempt: run.attempt,
    state: stateView(run.state, reveal),
  })),
})

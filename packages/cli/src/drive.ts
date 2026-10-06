import {
  RETRY_GUARD,
  type RetryGuardConjunct,
  type TaskAdmission,
  type TaskFacts,
  isLiveState,
  isPortRefusal,
  parseTaskValueJson,
  refuseReservedEventName,
  requirePortString,
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
 * A JSON string or a JSON number, as the grammar writes each. A string is matched so that
 * the digits inside one are not read as a number. A number is matched in its parts: the
 * digits before the point, the digits after it, and the exponent.
 */
const JSON_STRING_OR_NUMBER =
  /"(?:[^"\\]|\\.)*"|-?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/g

/**
 * Why a JSON text cannot be stored as it was written, or null when it can. Reading a number
 * makes it a double, and three kinds of number are another number once read. One past
 * what a double holds is read as no finite number and would be written as `null`. One that
 * is not zero and is nearer zero than any double would be written as `0`. And an integer
 * that no double is would be written as another integer. Each is a document other than
 * the one the caller passed.
 *
 * The refusal is over the number's value and not its spelling: an integer is one however
 * it is written, as digits alone, with a fraction part of zeros, or with an exponent. So
 * the token is read exactly, as its digits times a power of ten, and compared with the
 * double. A number that is no integer is left to the double nearest it. The text is one
 * JSON value already, so every digit outside a string is part of a number.
 */
function numberNotHeld(text: string): string | null {
  for (const [token, whole, fraction = '', exponent = '0'] of text.matchAll(
    JSON_STRING_OR_NUMBER,
  )) {
    if (token.startsWith('"')) continue
    const read = Number(token)
    if (!Number.isFinite(read)) {
      return 'holds a number that is not finite once it is read, as 1e400 is, so it would be stored as null'
    }
    // The number as it is written, without its sign: `kept` times ten to the `power`,
    // where `kept` ends in no zero.
    const digits = `${whole}${fraction}`
    const kept = digits.replace(/0+$/, '')
    // Zero, however it is written.
    if (kept === '') continue
    if (read === 0) {
      return 'holds a number that is not zero as it is written and reads as zero, as 1e-400 is, so it would be stored as 0'
    }
    const power = Number(exponent) - fraction.length + (digits.length - kept.length)
    // A finite number has at most 309 digits before its point, so the power is small here.
    if (power >= 0 && BigInt(kept) * 10n ** BigInt(power) !== BigInt(Math.abs(read))) {
      return 'holds an integer a double cannot hold, as 12345678901234567890 is however it is written, so it would be stored as another number: pass it as a string'
    }
  }
  return null
}

/**
 * A JSON argument as the port is handed it: parsed and written again by the two functions
 * the hosted routes hand a store's port its JSON through, so a task enqueued here holds
 * the bytes the same parameters hold when they are enqueued over HTTP. No value is `null`,
 * as it is there. Text that is not one JSON value is refused, and so is a document that
 * would not be stored as it was written, with the reason (`numberNotHeld`): what is stored,
 * and what a printed digest is of, is then what the caller passed. No refusal quotes the
 * text, which is a value a user wrote.
 */
export function jsonArgument(
  text: string | undefined,
): { readonly json: string } | { readonly refused: string } {
  try {
    // The label is for a message this function never lets out: its refusal says nothing of the text.
    const value = text === undefined ? null : parseTaskValueJson(text)
    const notHeld = numberNotHeld(text ?? 'null')
    if (notHeld !== null) return { refused: `${notHeld}. What it was given is not printed` }
    return { json: serializeTaskValue('a JSON argument', value) }
  } catch {
    return { refused: 'takes one JSON value, as in {"a":1}. What it was given is not printed' }
  }
}

/**
 * Whether a refusal of `spawn` is of its queue or of its task name: the two strings the
 * port checks before the key, in the order of its arguments, each asked of core's own
 * check of it. A queue and a task name print everywhere, so the words of such a refusal
 * print. Any other refusal may quote the idempotency key, the one value a user wrote that
 * the call carries as text: a refusal of the key does, and so may one this function does
 * not know of. So what it cannot name as printable is hidden, and the words of a refusal
 * are never searched: a key of one letter is in every sentence.
 */
export function refusesAnArgumentThatPrints(queue: string, taskName: string): boolean {
  try {
    requirePortString('queue', queue)
    requirePortString('taskName', taskName)
    return false
  } catch (error) {
    if (isPortRefusal(error)) return true
    throw error
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
  /** Every conjunct the read did not ask, because a counter it computes with is out of range. */
  readonly conjunctsNotAsked: readonly RetryGuardConjunct[]
  readonly message: string
}

/**
 * Why the retry guard refuses a task, from the read of each of its conjuncts: the false
 * ones, and the cause each gives. The read is of the task after the refusal, so the cause
 * is the one that stands as of that read. When every conjunct holds, the task changed
 * between the call and the read, and the answer says so and names no cause.
 */
export function retryRefusal(taskId: string, admission: TaskAdmission): RetryRefusal {
  const conjunctsNotHeld = RETRY_GUARD.filter((name) => admission.retry[name] === false)
  const conjunctsNotAsked = RETRY_GUARD.filter((name) => admission.retry[name] === 'not-asked')
  const causes = [...new Set(conjunctsNotHeld.map((name) => CAUSE_OF_CONJUNCT[name]))]
  const [cause] = causes
  if (cause === undefined) {
    return {
      cause: 'none-as-of-this-read',
      causes,
      conjunctsNotHeld,
      conjunctsNotAsked,
      message: `retry of task ${taskId} was refused, and every conjunct of the retry guard holds as of this read: the task changed between the call and the read. Run it again. Nothing was changed`,
    }
  }
  return {
    cause,
    causes,
    conjunctsNotHeld,
    conjunctsNotAsked,
    message: `retry of task ${taskId} was refused. As of this read: ${causes.map((one) => CAUSE_SAYS[one]).join('; ')}. Nothing was changed`,
  }
}

/** The live run of a task that is live, which a retry reports and does not revive. */
export const liveRunOf = (admission: TaskAdmission) =>
  isLiveState(admission.state) ? admission.runs.find((run) => isLiveState(run.state)) : undefined

/**
 * What `retry --yes` would do with a task, from the read of the guard's conjuncts the
 * command makes before the call: report the live run of a task that is live, be refused
 * for the causes the false conjuncts give, or revive the task. It is the reading the
 * command makes of the same read after a call the port refused, so one state has one
 * cause whether the command was confirmed or not. The task can move between this read and
 * a call, and the message says the read is what it speaks of.
 */
export function retryForecast(
  taskId: string,
  admission: TaskAdmission,
): { readonly view: Record<string, unknown>; readonly message: string } {
  const liveRun = liveRunOf(admission)
  if (liveRun !== undefined) {
    return {
      view: { wouldBe: 'already-live', runId: liveRun.runId },
      message: `task ${taskId} is live as of this read, and only a failed task is revived: retry would change nothing, and would report its live run. Nothing was changed`,
    }
  }
  const refusal = retryRefusal(taskId, admission)
  if (refusal.cause !== 'none-as-of-this-read') {
    return {
      view: {
        wouldBe: 'refused',
        cause: refusal.cause,
        causes: refusal.causes,
        conjunctsNotHeld: refusal.conjunctsNotHeld,
        conjunctsNotAsked: refusal.conjunctsNotAsked,
      },
      message: `retry would be refused for task ${taskId}, so --yes would change nothing. As of this read: ${refusal.causes.map((one) => CAUSE_SAYS[one]).join('; ')}. Nothing was changed`,
    }
  }
  return {
    view: { wouldBe: 'revived' },
    message: `retry would revive task ${taskId}: a new pending run, due now, one ordinal past its top run, and one more attempt in its budget. Run it again with --yes. Nothing was changed`,
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

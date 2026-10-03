import {
  type AwaitedEventFacts,
  type CorruptInteger,
  type RunFacts,
  type TaskFacts,
  type TaskRowFacts,
  type WaitFacts,
  isLiveState,
  isTerminalState,
} from '@durablerun/core'
import { type UserValue, userValue } from './render.js'

/**
 * What a view prints of one of core's facts: every member, each named here. The type holds
 * one thing: a member core adds stops the build until a view names it, so no fact goes
 * unprinted because nobody listed it. It does not hold how a member prints. A view that
 * names a value a user wrote and prints it in the clear still builds, and the redaction
 * cases are what fail.
 */
type Printed<Facts> = Record<keyof Facts, unknown>

/** Whether a stored state is one of the engine's own, as core tells them. */
const isState = (stored: string): boolean => isLiveState(stored) || isTerminalState(stored)

/** The two statuses of a wait, which every dialect's schema checks. Core names no list of them. */
const WAIT_STATUSES: ReadonlySet<string> = new Set(['waiting', 'delivered'])
const isStatus = (stored: string): boolean => WAIT_STATUSES.has(stored)

/**
 * A stored state or status. One of the engine's own prints as it is. Any other text is a
 * stored value nothing vouches for, so it prints as a value a user wrote does, as its
 * length and sha256 unless revealed. The reason a decoder refused the row with quotes the
 * same text, and prints only when revealed.
 */
const oneOf = (
  known: (stored: string) => boolean,
  stored: string,
  reveal: boolean,
): string | UserValue => (known(stored) ? stored : userValue(stored, reveal))

/** A task's own row. Its id and queue print beside the command, and the key is a user's value. */
const taskView = (
  task: TaskRowFacts,
  reveal: boolean,
): Printed<Omit<TaskRowFacts, 'taskId' | 'queue'>> => ({
  taskName: task.taskName,
  state: oneOf(isState, task.state, reveal),
  attempts: task.attempts,
  maxAttempts: task.maxAttempts,
  infraRetries: task.infraRetries,
  enqueueAtMs: task.enqueueAtMs,
  firstStartedAtMs: task.firstStartedAtMs,
  cancelAtMs: task.cancelAtMs,
  idempotencyKey: task.idempotencyKey === null ? null : userValue(task.idempotencyKey, reveal),
  parentTaskId: task.parentTaskId,
  sagaBegan: task.sagaBegan,
})

const runView = (run: RunFacts, reveal: boolean): Printed<RunFacts> => ({
  runId: run.runId,
  queue: run.queue,
  state: oneOf(isState, run.state, reveal),
  attempt: run.attempt,
  claimGen: run.claimGen,
  activatedGen: run.activatedGen,
  relaunchCount: run.relaunchCount,
  claimExpiresAtMs: run.claimExpiresAtMs,
  heartbeatAtMs: run.heartbeatAtMs,
  availableAtMs: run.availableAtMs,
  wakeEvent: run.wakeEvent,
  wakeStep: run.wakeStep,
  startedAtMs: run.startedAtMs,
  completedAtMs: run.completedAtMs,
  failedAtMs: run.failedAtMs,
})

const waitView = (wait: WaitFacts, reveal: boolean): Printed<WaitFacts> => ({
  runId: wait.runId,
  stepName: wait.stepName,
  eventName: wait.eventName,
  status: oneOf(isStatus, wait.status, reveal),
  timeoutAtMs: wait.timeoutAtMs,
  createdAtMs: wait.createdAtMs,
})

const eventView = (event: AwaitedEventFacts): Printed<AwaitedEventFacts> => ({
  eventName: event.eventName,
  exists: event.exists,
  emittedAtMs: event.emittedAtMs,
})

/** A corrupt integer. Its value is a number's text and never a value of another kind. */
const corruptView = (entry: CorruptInteger): Printed<Required<CorruptInteger>> => ({
  field: entry.field,
  runId: entry.runId,
  stepName: entry.stepName,
  eventName: entry.eventName,
  reason: entry.reason,
  stored: entry.stored,
  value: entry.value,
})

/**
 * What `inspect` prints of one task's facts, every member of them: the type stops the build
 * when core adds one that is not named here. Task ids, task names, event names and step
 * keys print, as they do everywhere. The idempotency key is a value a user wrote, so it
 * prints as its length and sha256 unless revealed, and a child's key, which the engine
 * built from its parent's id and a step key, prints the same way beside the parent it
 * names. The outcome is handed in already rendered, by what `result` prints an outcome
 * through, so the two commands cannot print one outcome two ways.
 */
export function factsView(
  facts: TaskFacts,
  outcome: Readonly<Record<string, unknown>>,
  reveal: boolean,
): Printed<Omit<TaskFacts, 'nowMs'>> & { readonly databaseNowEpochMs: unknown } {
  return {
    databaseNowEpochMs: facts.nowMs,
    fakeClock: facts.fakeClock,
    task: taskView(facts.task, reveal),
    outcome,
    runs: facts.runs.map((run) => runView(run, reveal)),
    waits: facts.waits.map((wait) => waitView(wait, reveal)),
    events: facts.events.map(eventView),
    corrupt: facts.corrupt.map(corruptView),
  }
}

/**
 * The task, the runs and the waits whose stored state or status is not one of the engine's
 * own, each by its field and the ids that name its row: none for the task, which the
 * answer already names. The stored text is left out: nothing vouches for it.
 */
export function statesNotTheEngines(
  facts: TaskFacts,
): { readonly field: string; readonly runId?: string; readonly stepName?: string }[] {
  return [
    ...(isState(facts.task.state) ? [] : [{ field: 'tasks.state' }]),
    ...facts.runs
      .filter((run) => !isState(run.state))
      .map((run) => ({ field: 'runs.state', runId: run.runId })),
    ...facts.waits
      .filter((wait) => !isStatus(wait.status))
      .map((wait) => ({ field: 'waits.status', runId: wait.runId, stepName: wait.stepName })),
  ]
}

/**
 * Whether every row the facts were read from was readable: the outcome decoded, no integer
 * was corrupt, and every run's state and every wait's status is one of the engine's own. A
 * task's own state needs no check here, because the outcome's decoder refuses any other.
 */
export function factsAreReadable(facts: TaskFacts): boolean {
  return (
    'result' in facts.outcome &&
    facts.corrupt.length === 0 &&
    facts.runs.every((run) => isState(run.state)) &&
    facts.waits.every((wait) => isStatus(wait.status))
  )
}

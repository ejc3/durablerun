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
export type Printed<Facts> = Record<keyof Facts, unknown>

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

/** A task's or a run's stored state, as any command prints one: the engine's own as it is, any other hidden unless revealed. */
export const stateView = (stored: string, reveal: boolean): string | UserValue =>
  oneOf(isState, stored, reveal)

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
export const corruptView = (entry: CorruptInteger): Printed<Required<CorruptInteger>> => ({
  field: entry.field,
  taskId: entry.taskId,
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

/** One thing in a task's facts that is not readable, by its field and the ids that name its row. */
export interface NotReadable {
  readonly field: string
  readonly runId?: string | undefined
  readonly stepName?: string | undefined
  readonly eventName?: string | undefined
}

/** A corrupt integer by its field and the ids that name its row, with what it stores left out. */
export const rowNamed = ({ field, runId, stepName, eventName }: CorruptInteger): NotReadable => ({
  field,
  runId,
  stepName,
  eventName,
})

/**
 * What in a task's facts is not readable, each thing by its field and the ids that name
 * its row: an outcome the decoders refuse, every corrupt integer, and the task and each run
 * or wait whose stored state or status is not one of the engine's own. The stored text is
 * left out: nothing vouches for it. A task's facts are readable when this list is empty.
 * It is the one definition: `inspect` exits `unreadable` on a list that is not empty, and
 * `explain` answers the cause `unreadable` and prints the list.
 */
export function whatIsNotReadable(facts: TaskFacts): NotReadable[] {
  return [
    ...('result' in facts.outcome ? [] : [{ field: 'outcome' }]),
    ...facts.corrupt.map(rowNamed),
    ...(isState(facts.task.state) ? [] : [{ field: 'tasks.state' }]),
    ...facts.runs
      .filter((run) => !isState(run.state))
      .map((run) => ({ field: 'runs.state', runId: run.runId })),
    ...facts.waits
      .filter((wait) => !isStatus(wait.status))
      .map((wait) => ({ field: 'waits.status', runId: wait.runId, stepName: wait.stepName })),
  ]
}

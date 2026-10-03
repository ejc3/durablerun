import type {
  AwaitedEventFacts,
  CorruptInteger,
  RunFacts,
  TaskFacts,
  TaskRowFacts,
  WaitFacts,
} from '@durablerun/core'
import { userValue } from './render.js'

/**
 * What a view prints of one of core's facts: every member, each named here. A member core
 * adds stops the build until a view says how it prints, so a value a user wrote cannot
 * reach a terminal because nobody listed it.
 */
type Printed<Facts> = Record<keyof Facts, unknown>

/** A task's own row. Its id and queue print beside the command, and the key is a user's value. */
const taskView = (
  task: TaskRowFacts,
  reveal: boolean,
): Printed<Omit<TaskRowFacts, 'taskId' | 'queue'>> => ({
  taskName: task.taskName,
  state: task.state,
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

const runView = (run: RunFacts): Printed<RunFacts> => ({
  runId: run.runId,
  queue: run.queue,
  state: run.state,
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

const waitView = (wait: WaitFacts): Printed<WaitFacts> => ({
  runId: wait.runId,
  stepName: wait.stepName,
  eventName: wait.eventName,
  status: wait.status,
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
 * What `inspect` prints of one task's facts. Task ids, task names, event names and step
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
): Record<string, unknown> {
  return {
    databaseNowEpochMs: facts.nowMs,
    fakeClock: facts.fakeClock,
    task: taskView(facts.task, reveal),
    outcome,
    runs: facts.runs.map(runView),
    waits: facts.waits.map(waitView),
    events: facts.events.map(eventView),
    corrupt: facts.corrupt.map(corruptView),
  }
}

/** Whether every row the facts were read from was readable: the outcome decoded, and no integer was corrupt. */
export function factsAreReadable(facts: TaskFacts): boolean {
  return 'result' in facts.outcome && facts.corrupt.length === 0
}

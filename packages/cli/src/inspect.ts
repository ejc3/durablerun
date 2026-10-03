import type { TaskFacts } from '@durablerun/core'
import { userValue } from './render.js'

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
  const { taskId: _taskId, queue: _queue, idempotencyKey, ...task } = facts.task
  return {
    databaseNowEpochMs: facts.nowMs,
    fakeClock: facts.fakeClock,
    task: {
      ...task,
      idempotencyKey: idempotencyKey === null ? null : userValue(idempotencyKey, reveal),
    },
    outcome,
    runs: facts.runs,
    waits: facts.waits,
    events: facts.events,
    corrupt: facts.corrupt,
  }
}

/** Whether every row the facts were read from was readable: the outcome decoded, and no integer was corrupt. */
export function factsAreReadable(facts: TaskFacts): boolean {
  return 'result' in facts.outcome && facts.corrupt.length === 0
}

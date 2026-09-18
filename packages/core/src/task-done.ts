import { EventName, type TaskOutcome, encodeTaskOutcome } from './child-tasks.js'
import type { FencedBatch } from './fenced-batch.js'
import { taskDoneEventInsert } from './statements/events.js'

/** What a dialect supplies to a terminal batch's completion event: its wake, and one read. */
export interface TaskDoneStore {
  /** Add the statements that wake every run parked on `name`, under the fence `event`. */
  wake(name: EventName): void
  /** Whether the task's completion event exists. Asked only off the common path. */
  isRecorded(): Promise<boolean>
}

/**
 * What every terminal batch owes a task's parent (DESIGN.md §3.2, ChildTasks.tla's
 * ChildTerminal): the task's completion event, and the wake of every run parked on it,
 * in the batch that ends the task. `terminal` names the statement that made the task
 * terminal, so a batch that ended nothing writes no event and wakes nobody. Every
 * dialect adds them through here, and runs the check this returns on the batch's
 * results.
 *
 * The insert writes one row or none, and none passes every row-count audit. When the
 * statement named `terminal` did end the task, only an event an earlier ending recorded
 * explains an insert that wrote nothing, which is a revived task ending again. Anything
 * else is a batch that names the wrong task or the wrong terminal statement, and the
 * check says so.
 */
export function addTaskDone(
  b: FencedBatch,
  ended: { queue: string; taskId: string; terminal: string; outcome: TaskOutcome },
  store: TaskDoneStore,
): (results: Awaited<ReturnType<FencedBatch['run']>>['results']) => Promise<void> {
  const { queue, taskId, terminal, outcome } = ended
  b.followOnTree(
    'event',
    taskDoneEventInsert({ queue, taskId, payloadJson: encodeTaskOutcome(outcome), terminal }),
    'one',
  )
  store.wake(EventName.taskDone(taskId))
  return async (results) => {
    const endedHere = (results[terminal]?.rowsAffected ?? 0) > 0
    const inserted = (results.event?.rowsAffected ?? 0) > 0
    if (!endedHere || inserted || (await store.isRecorded())) return
    throw new Error(
      `${b.label} ended task ${taskId} and recorded no completion event: the batch names the wrong task or the wrong terminal statement`,
    )
  }
}

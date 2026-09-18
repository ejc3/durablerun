import { EventName, type TaskOutcome, encodeTaskOutcome } from './child-tasks.js'
import type { FencedBatch } from './fenced-batch.js'
import { taskDoneEventInsert } from './statements/events.js'

/** What a dialect supplies to a terminal batch's completion event: its wake. */
export interface TaskDoneStore {
  /** Add the statements that wake every run parked on `name`, under the fence `event`. */
  wake(name: EventName): void
}

/**
 * What every terminal batch owes a task's parent (DESIGN.md §3.2, ChildTasks.tla's
 * ChildTerminal): the task's completion event, and the wake of every run parked on it,
 * in the batch that ends the task. `terminal` names the statement that made the task
 * terminal, so a batch that ended nothing writes no event and wakes nobody. Every
 * dialect adds them through here.
 *
 * Nothing is checked after the batch. A terminal write's answer is its batch's answer,
 * and a read after the commit could only change that answer for a transition that has
 * happened. A batch that names the wrong task or the wrong terminal statement would end
 * the task with no event, and an insert that writes nothing passes every row-count
 * audit. What holds that is `childTaskViolations`, which every conformance case, every
 * fuzz walk, and the SDK harness run over the rows, with one case for each terminal label.
 */
export function addTaskDone(
  b: FencedBatch,
  ended: { queue: string; taskId: string; terminal: string; outcome: TaskOutcome },
  store: TaskDoneStore,
): void {
  const { queue, taskId, terminal, outcome } = ended
  b.followOnTree(
    'event',
    taskDoneEventInsert({ queue, taskId, payloadJson: encodeTaskOutcome(outcome), terminal }),
    'one',
  )
  store.wake(EventName.taskDone(taskId))
}

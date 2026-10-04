import {
  SAGA_PHASE_CHECKPOINT,
  type SqlExecutor,
  type SqlRow,
  isLiveState,
  taskDoneEventName,
  taskIdOfDoneEvent,
} from '@durablerun/core'
import { eventKey } from './invariants.js'

/**
 * The name a parent's spawn memo is stored under begins with this: the SDK's `ctx.spawn`
 * keeps the child it created in a checkpoint named `$spawn:` and the task name, with a
 * counter after the first use. The SDK's own test of a memo whose child is gone holds this
 * reading to what the SDK writes.
 */
const SPAWN_MEMO_PREFIX = '$spawn:'

/** The task a spawn memo holds, or null for a state that is not a child handle. */
function childOfSpawnMemo(state: unknown): string | null {
  let handle: unknown
  try {
    handle = JSON.parse(String(state))
  } catch {
    return null
  }
  if (typeof handle !== 'object' || handle === null) return null
  const { taskId, queue } = handle as { taskId?: unknown; queue?: unknown }
  return typeof taskId === 'string' && typeof queue === 'string' ? taskId : null
}

/**
 * What specs/Retention.tla requires of the rows, where no other checker reads it (DESIGN.md
 * §3.12). No store deletes a task yet, so every surface that judges a history passes, and
 * these are the states a wrong purge would leave. Like `childTaskViolations` it is not
 * part of the invariant library, which also judges rows the poison matrix writes by hand:
 * that matrix seeds a completed task with no run.
 *
 * - WholeUnit, the half the invariant library does not hold: every task row has a run. The
 *   library flags a task with no run only while the task is live.
 * - ReplayableParentKeepsChild: a task that can still run its code, which is a live task
 *   or a failed one whose saga never began, holds no spawn memo whose child is gone. The
 *   child is read from the stored memo, and never from a child's key.
 * - NoStrandedWaiter: a wait on a completion event has that task in its queue, or the
 *   event.
 */
export async function retentionViolations(raw: SqlExecutor): Promise<string[]> {
  const results = await raw.batch(
    'retention-violations',
    [
      { sql: 'SELECT task_id, queue, state FROM tasks', args: [] },
      { sql: 'SELECT task_id FROM runs', args: [] },
      { sql: 'SELECT task_id, checkpoint_name, state FROM checkpoints', args: [] },
      { sql: 'SELECT run_id, step_name, queue, event_name FROM waits', args: [] },
      { sql: 'SELECT queue, event_name FROM events', args: [] },
    ],
    'read',
  )
  // A read that answered nothing is a harness defect, and it fails here. Read as no rows,
  // it would pass every history.
  const rowsOf = (index: number): readonly SqlRow[] => {
    const rows = results[index]?.rows
    if (!Array.isArray(rows)) throw new Error(`retention rows: read ${index} answered no rows`)
    return rows
  }
  const tasks = rowsOf(0)
  const runs = rowsOf(1)
  const checkpoints = rowsOf(2)
  const waits = rowsOf(3)
  const events = rowsOf(4)
  // Each condition's findings are ordered by code unit, so the answer does not depend on
  // the order a database returns rows in.
  const noRun: string[] = []
  const memos: string[] = []
  const stranded: string[] = []

  const hasARun = new Set(runs.map((run) => String(run.task_id)))
  for (const task of tasks) {
    const taskId = String(task.task_id)
    if (!hasARun.has(taskId)) noRun.push(`task-without-a-run: ${taskId}`)
  }

  const exists = new Set(tasks.map((task) => String(task.task_id)))
  const sagaBegan = new Set(
    checkpoints
      .filter((checkpoint) => String(checkpoint.checkpoint_name) === SAGA_PHASE_CHECKPOINT)
      .map((checkpoint) => String(checkpoint.task_id)),
  )
  const canStillRunItsCode = new Set(
    tasks
      .filter(
        (task) =>
          isLiveState(task.state) ||
          (task.state === 'failed' && !sagaBegan.has(String(task.task_id))),
      )
      .map((task) => String(task.task_id)),
  )
  for (const checkpoint of checkpoints) {
    const name = String(checkpoint.checkpoint_name)
    const parent = String(checkpoint.task_id)
    if (!name.startsWith(SPAWN_MEMO_PREFIX) || !canStillRunItsCode.has(parent)) continue
    const child = childOfSpawnMemo(checkpoint.state)
    if (child === null) {
      memos.push(`spawn-memo-without-its-task: ${parent}/${name} holds no child handle`)
    } else if (!exists.has(child)) {
      memos.push(`spawn-memo-without-its-task: ${parent}/${name} names ${child}`)
    }
  }

  const eventOfATask = new Set(
    tasks.map((task) => eventKey(String(task.queue), taskDoneEventName(String(task.task_id)))),
  )
  const stored = new Set(
    events.map((event) => eventKey(String(event.queue), String(event.event_name))),
  )
  for (const wait of waits) {
    const eventName = String(wait.event_name)
    const awaited = taskIdOfDoneEvent(eventName)
    if (awaited === null) continue
    const event = eventKey(String(wait.queue), eventName)
    if (eventOfATask.has(event) || stored.has(event)) continue
    stranded.push(
      `completion-wait-without-its-task-or-event: ${String(wait.run_id)}/${String(wait.step_name)} awaits ${awaited}`,
    )
  }
  return [...noRun.sort(), ...memos.sort(), ...stranded.sort()]
}

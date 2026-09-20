import {
  EventName,
  type RunTaskMemo,
  type TaskOutcome,
  childAwaitRefusal,
  encodeTaskOutcome,
} from './child-tasks.js'
import { type FencedBatch, type FencedResult, prepareRead, readRows } from './fenced-batch.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlFragment } from './sql-tree.js'
import {
  emittedEventRead,
  materializeTaskDoneCas,
  taskDoneEventInsert,
} from './statements/events.js'
import { runTaskRead, taskDoneStateRead } from './statements/reads.js'
import { decodeTaskResult } from './task-result.js'
import { type TaskResult, isTerminalState } from './types.js'

// A child await's error reaches task code, so it is built from the captured constructor.
const { RangeError: TrustedRangeError } = TASK_INTRINSICS

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
 * A batch is held to this when it is built: one that writes a terminal `tasks.state`
 * and records no completion event under that statement's stamp is refused when it runs,
 * and the event's statement names the lock the batch then holds. Nothing is checked
 * after the batch. A terminal write's answer is its batch's answer, and a read after the
 * commit could only change that answer for a transition that has happened. A batch that
 * names the wrong task would end the task with no event, and an insert that writes
 * nothing passes every row-count audit. What holds that is `childTaskViolations`, which
 * every conformance case, every fuzz walk, and the SDK harness run over the rows, with
 * one case for each terminal label.
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

/** What an await answers: the event's payload, or that the run parked on it. */
export type AwaitAnswer = { emitted: true; payloadJson: string } | { emitted: false }

/** A child await: the claim it is made under, the step, the child, and the timeout. */
export interface ChildAwait {
  readonly queue: string
  readonly taskId: string
  readonly runId: string
  readonly claimToken: string
  readonly stepName: string
  readonly childTaskId: string
  readonly timeoutSeconds: number | null
}

/**
 * What a dialect supplies to the engine's side of a task's ending and of a child await.
 * Each member is a fact of the dialect: its batches and how it runs one, its `await-event`
 * batch, how it says why a fence refused a write, and three fragments. The reads, the
 * rounds of the await, the classification of a refusal, and the batch that records an
 * unrecorded ending are core's, so a dialect inherits them and cannot write them another
 * way.
 *
 * A dialect opens each batch itself and runs it itself, so every batch label stays a
 * literal at a construction site in a store, and every batch reaches the executor from a
 * store: that is where the label ledger, the batch lint, and the fault matrix read them.
 */
export interface TaskDoneDialect {
  /** Run a batch this dialect opened against its executor. */
  run(batch: FencedBatch): Promise<FencedResult>
  readonly open: {
    /** `run-task`, a batch of reads. */
    runTask(): FencedBatch
    /** `task-done-state`, a batch of reads. */
    taskDoneState(): FencedBatch
    /** `record-task-done`, a transition under a seed no other invocation uses. */
    recordTaskDone(): FencedBatch
  }
  /**
   * The dialect's `await-event` batch for `name`, the completion event of the awaited
   * child: its answer, or null when it neither hit the event nor registered a wait.
   */
  awaitNamedEvent(awaited: ChildAwait, name: EventName): Promise<AwaitAnswer | null>
  /** Why the fence of `runId` refused a write, as the error to throw. */
  refusal(operation: string, runId: string): Promise<Error>
  /** The store's join of the run `r` to the task `t` that owns it. */
  readonly taskOwnsRun: SqlFragment
  /** What the store requires of the task `t` for it to be live. */
  readonly liveTask: SqlFragment
  /** How the dialect names a stored payload's type. */
  readonly storedPayloadType: SqlFragment
}

const RUN_TASK = prepareRead(
  { queue: 'string', runId: 'string' },
  (binds: { queue: string; runId: string }) => runTaskRead(binds),
)
const TASK_DONE_STATE = prepareRead({ taskId: 'string' }, (binds: { taskId: string }) =>
  taskDoneStateRead(binds),
)

/**
 * A run's task, read before the batch that ends the run. A terminal batch names its
 * task's completion event, and `complete` and `fail` are handed only the run. The
 * task of a run never changes, so an unfenced read is safe, and so is the answer
 * `activate` gave this store a moment ago, which costs no read. A run remembered
 * under another queue still loses, because the batch's compare-and-set names the
 * queue. A run this queue does not have is refused here as the batch would refuse it.
 */
export async function endingTask(
  dialect: TaskDoneDialect,
  remembered: RunTaskMemo,
  operation: string,
  queue: string,
  runId: string,
): Promise<string> {
  const known = remembered.recall(runId)
  if (known !== undefined) return known
  const b = dialect.open.runTask()
  b.readPrepared('task', RUN_TASK, { queue, runId })
  const rows = readRows(b, await dialect.run(b), 'task')
  const taskId = rows[0]?.task_id
  if (typeof taskId !== 'string') throw await dialect.refusal(operation, runId)
  return taskId
}

/**
 * The child await (DESIGN.md §3.2, specs/ChildTasks.tla): `await-event` for the
 * completion event of `childTaskId`. The batch decides everything the model's await
 * does in one step: it hits an event that exists, and it registers only on a live
 * child in this queue. An await that did neither reads the child, once, to say why.
 * A child in another queue, or no such task, is refused. A child that ended with
 * nothing recorded has its outcome recorded by the await itself, in a second batch
 * fenced on the row that was read. Anything else is this run's own claim, lost.
 */
export async function awaitTaskDone(
  dialect: TaskDoneDialect,
  awaited: ChildAwait,
): Promise<AwaitAnswer> {
  const { queue, runId, childTaskId } = awaited
  const name = EventName.awaitedTaskDone(childTaskId)
  // A child revived before the read, or between the read and the batch that records it,
  // is live again, so the next round registers. Two rounds cover that. A live child that
  // two rounds could not register on is this run's own refusal, as it is for awaitEvent:
  // the claim is lost, the task is cancelled, or the timeout does not fit.
  for (let round = 0; round < 2; round++) {
    const answer = await dialect.awaitNamedEvent(awaited, name)
    if (answer !== null) return answer
    const child = await taskDoneState(dialect, childTaskId)
    const refusal = childAwaitRefusal(queue, childTaskId, child?.queue)
    if (refusal !== null) throw refusal
    // A live child was revived since the batch looked, and the next round registers on it.
    if (child === null || !isTerminalState(child.outcome.state)) continue
    const recorded = await recordTaskDone(
      dialect,
      awaited,
      child.stamp,
      child.outcome as TaskOutcome,
    )
    if (recorded !== null) return recorded
  }
  throw await dialect.refusal('awaitTaskDone', runId)
}

/**
 * A task as a child await sees it: its queue, its outcome, and the stamp its row
 * carries. Read only off the common path: by an await that neither registered nor
 * hit, to say why.
 */
async function taskDoneState(
  dialect: TaskDoneDialect,
  taskId: string,
): Promise<{ queue: string; outcome: TaskResult; stamp: string | null } | null> {
  const b = dialect.open.taskDoneState()
  b.readPrepared('task', TASK_DONE_STATE, { taskId })
  const rows = readRows(b, await dialect.run(b), 'task')
  const row = rows[0]
  if (row === undefined) return null
  return {
    queue: String(row.queue),
    outcome: decodeTaskResult(taskId, row),
    stamp: row.fence_stamp === null ? null : String(row.fence_stamp),
  }
}

/**
 * Record the outcome of a child that ended with no completion event, and answer the
 * await with it (ChildTasks.tla's AwaitMaterialize). Null when the batch recorded
 * nothing and found no event: the child's row is no longer the one that was read, or
 * this run's claim is gone.
 */
async function recordTaskDone(
  dialect: TaskDoneDialect,
  awaited: ChildAwait,
  childStamp: string | null,
  outcome: TaskOutcome,
): Promise<Extract<AwaitAnswer, { emitted: true }> | null> {
  const { queue, taskId, runId, claimToken, childTaskId } = awaited
  const name = EventName.taskDone(childTaskId)
  const b = dialect.open.recordTaskDone()
  const awaiting = { queue, taskId, runId, claimToken, taskOwnsRun: dialect.taskOwnsRun }
  b.casTree(
    'materialize',
    materializeTaskDoneCas({
      ...awaiting,
      childTaskId,
      eventName: name,
      payloadJson: encodeTaskOutcome(outcome),
      childStamp,
      liveTask: dialect.liveTask,
    }),
  )
  b.openTailTree(
    'hit',
    'the event may be one a terminal batch wrote since the read; the live claim token is the fence here',
    emittedEventRead({
      ...awaiting,
      eventName: name,
      payloadType: dialect.storedPayloadType,
      liveTask: dialect.liveTask,
    }),
  )
  const { results } = await dialect.run(b)
  const row = results.hit?.rows[0]
  if (row === undefined) return null
  if (row.payload_type !== 'text') {
    throw new TrustedRangeError(
      `awaitTaskDone ${queue}/task ${childTaskId} found a non-TEXT stored payload`,
    )
  }
  return { emitted: true, payloadJson: String(row.payload) }
}

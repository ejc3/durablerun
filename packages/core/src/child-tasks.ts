/**
 * Child tasks (DESIGN.md §3.2, specs/ChildTasks.tla): the completion event a
 * task's first terminal transition writes, and the refusals that protect it.
 * These are contract values. Every dialect and the SDK build the event's name,
 * payload, and refusals from this one file.
 */

import { type TaskResult, type TerminalState, isTerminalState } from './types.js'

/** Event names with this prefix belong to the engine. No caller of the port may emit or await one. */
export const RESERVED_EVENT_PREFIX = '$'

const TASK_DONE_EVENT_PREFIX = `${RESERVED_EVENT_PREFIX}task-done:`

/** The completion event of one task. It lives in the task's own queue, like every event. */
export function taskDoneEventName(taskId: string): string {
  return `${TASK_DONE_EVENT_PREFIX}${taskId}`
}

/**
 * Refuse a reserved event name at the store's port. A caller that could emit a
 * completion event's name would win first-write-wins and forge a child's
 * result, and one that could await it would skip the queue rule.
 */
export function refuseReservedEventName(operation: string, eventName: string): void {
  if (typeof eventName !== 'string') {
    throw new RangeError(`${operation} eventName must be a string`)
  }
  if (eventName.startsWith(RESERVED_EVENT_PREFIX)) {
    throw new RangeError(
      `${operation} eventName '${eventName}' is reserved: names that start with '${RESERVED_EVENT_PREFIX}' belong to the engine`,
    )
  }
}

/**
 * The first outcome a task reached, as its completion event carries it. It is
 * the shape `getTaskResult` answers with, narrowed to a terminal state. The two
 * can disagree on purpose: a failed task that is revived and then completes
 * keeps its first outcome here, so a parent's replay reads one answer forever.
 */
export type TaskOutcome = TaskResult & { state: TerminalState }

/** The completion event's payload. The terminal batch binds it, so SQL never builds JSON. */
export function encodeTaskOutcome(outcome: TaskOutcome): string {
  const ordered: Record<string, string> = { state: outcome.state }
  if (outcome.completedPayloadJson !== undefined) {
    ordered.completedPayloadJson = outcome.completedPayloadJson
  }
  if (outcome.failureReasonJson !== undefined) {
    ordered.failureReasonJson = outcome.failureReasonJson
  }
  return JSON.stringify(ordered)
}

/** Decode a completion event's payload, refusing anything `encodeTaskOutcome` could not have written. */
export function decodeTaskOutcome(taskId: string, payloadJson: string): TaskOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadJson)
  } catch {
    throw new RangeError(`task ${taskId} has a completion event that is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RangeError(`task ${taskId} has a completion event that is not an object`)
  }
  const fields = parsed as Record<string, unknown>
  const own = (name: string): unknown => (Object.hasOwn(fields, name) ? fields[name] : undefined)
  const state = own('state')
  if (!isTerminalState(state)) {
    throw new RangeError(`task ${taskId} has a completion event with no terminal state`)
  }
  const completed = own('completedPayloadJson')
  const failure = own('failureReasonJson')
  const isCompleted = state === 'completed'
  if (
    typeof (isCompleted ? completed : failure) !== 'string' ||
    (isCompleted ? failure : completed) !== undefined
  ) {
    throw new RangeError(
      `task ${taskId} has a completion event whose outcome contradicts its state ${state}`,
    )
  }
  return isCompleted
    ? { state, completedPayloadJson: completed as string }
    : { state, failureReasonJson: failure as string }
}

/**
 * An await of a child was refused, and nothing was registered. It is permanent:
 * the child is in another queue, or no such task exists, and neither changes.
 * Events are keyed by queue, so only a child in the parent's queue can wake it.
 */
export class ChildAwaitRefusedError extends Error {
  override readonly name = 'ChildAwaitRefusedError'
  constructor(
    readonly childTaskId: string,
    readonly reason: 'other-queue' | 'no-such-task',
  ) {
    super(
      reason === 'other-queue'
        ? `task ${childTaskId} is in another queue, and a child is awaited only within its parent's queue`
        : `task ${childTaskId} does not exist, so nothing would ever end the await`,
    )
  }
}

/**
 * The task of each run a store instance has handed out, so a terminal batch can name
 * its task's completion event without a read. `complete` and `fail` are handed only
 * the run, and the worker that calls them activated the run through the same store a
 * moment earlier. A run's task never changes and run ids are never reused, so an entry
 * cannot go stale, and a miss only costs the read. The oldest entry leaves first.
 */
export class RunTaskMemo {
  readonly #tasks = new Map<string, string>()
  readonly #capacity: number

  constructor(capacity = 1024) {
    this.#capacity = capacity
  }

  remember(runId: string, taskId: string): void {
    this.#tasks.delete(runId)
    this.#tasks.set(runId, taskId)
    if (this.#tasks.size > this.#capacity) {
      const oldest = this.#tasks.keys().next()
      if (!oldest.done) this.#tasks.delete(oldest.value)
    }
  }

  /** The run's task, if this store handed the run out and has not yet let the entry go. */
  recall(runId: string): string | undefined {
    return this.#tasks.get(runId)
  }
}

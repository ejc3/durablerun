/**
 * Child tasks (DESIGN.md §3.2, specs/ChildTasks.tla): the completion event a
 * task's first terminal transition writes, and the refusals that protect it.
 * These are contract values. Every dialect and the SDK build the event's name,
 * payload, and refusals from this one file.
 */

import { PortRefusalError } from './errors.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import { taskResultContradiction } from './task-result.js'
import { type SpawnOptions, type TaskResult, type TerminalState, isTerminalState } from './types.js'
import { requireDurableString, requireIdentifiersFit } from './validate.js'

// Task code shares this process, and this file decodes what task code will read, so it
// calls captured operations and reads own properties only, as `task-result.ts` does.
const {
  JSONParse: parseJson,
  JSONStringify: stringifyJson,
  ObjectHasOwn: hasOwn,
  RangeError: TrustedRangeError,
  StringStartsWith: startsWith,
} = TASK_INTRINSICS

/** Event names with this prefix belong to the engine. No caller of the port may emit or await one. */
export const RESERVED_EVENT_PREFIX = '$'

const TASK_DONE_EVENT_PREFIX = `${RESERVED_EVENT_PREFIX}task-done:`

/** The completion event of one task. It lives in the task's own queue, like every event. */
export function taskDoneEventName(taskId: string): string {
  return `${TASK_DONE_EVENT_PREFIX}${taskId}`
}

/** The task a completion event's name speaks for, or null for any other event name. */
export function taskIdOfDoneEvent(eventName: string): string | null {
  return startsWith(eventName, TASK_DONE_EVENT_PREFIX)
    ? eventName.slice(TASK_DONE_EVENT_PREFIX.length)
    : null
}

/**
 * Refuse a reserved event name at the store's port. A caller that could emit a
 * completion event's name would win first-write-wins and forge a child's result, and
 * one that could await it would skip the queue rule. The refusal is the caller's
 * mistake, so it is a `PortRefusalError`.
 */
export function refuseReservedEventName(operation: string, eventName: string): void {
  if (typeof eventName !== 'string') {
    throw new PortRefusalError(`${operation} eventName must be a string`)
  }
  if (startsWith(eventName, RESERVED_EVENT_PREFIX)) {
    throw new PortRefusalError(
      `${operation} eventName '${eventName}' is reserved: names that start with '${RESERVED_EVENT_PREFIX}' belong to the engine`,
    )
  }
}

/**
 * An event name a statement or a lock may carry. There are two ways to have one, and
 * both are here: a name a caller of the port supplied, which is refused when it is
 * reserved or when no store can keep it, and the completion event of a task, which only
 * the engine reaches. Every
 * event statement and the event lock take this and not a string, so a store method
 * cannot forget the refusal, and nothing outside this file can mint a reserved name.
 * It carries the task of a completion event, so nothing that holds one parses the
 * reserved name or is handed the task's id beside it.
 */
export class EventName {
  private declare readonly eventNameBrand: undefined

  private constructor(
    readonly value: string,
    /** The task whose completion event this is, or null for an event a caller named. */
    readonly taskId: string | null,
  ) {}

  static fromPort(operation: string, raw: string): EventName {
    refuseReservedEventName(operation, raw)
    return new EventName(requireDurableString(`${operation} eventName`, raw), null)
  }

  static taskDone(taskId: string): EventName {
    return new EventName(taskDoneEventName(taskId), taskId)
  }

  /**
   * The completion event a parent asks to await. Here the task id is a caller's, so it
   * and the name built from it, which is longer, are held to the width of an identifier.
   * The caller passed the id and never sees the name, so the refusal names the id. A
   * terminal batch names the event of a task it read from its own rows, through
   * `taskDone`, and is never refused.
   */
  static awaitedTaskDone(childTaskId: string): EventName {
    const name = taskDoneEventName(childTaskId)
    requireIdentifiersFit({
      childTaskId,
      'childTaskId, as the name of its completion event,': name,
    })
    return new EventName(name, childTaskId)
  }

  /**
   * The event as a message names it to a person: a caller's event by its name, and a
   * completion event by its task. The engine's reserved name never reaches task code,
   * and the error of an await does, so a message is built from this and not from `value`.
   */
  get display(): string {
    return this.taskId === null ? this.value : `task ${this.taskId}`
  }
}

/**
 * The first outcome a task reached, as its completion event carries it. It is
 * the shape `getTaskResult` answers with, narrowed to a terminal state. The two
 * can disagree on purpose: a failed task that is revived and then completes
 * keeps its first outcome here, so a parent's replay reads one answer forever.
 */
export type TaskOutcome = TaskResult & { state: TerminalState }

const OUTCOME_FIELDS = ['completedPayloadJson', 'failureReasonJson'] as const

/** The completion event's payload. The terminal batch binds it, so SQL never builds JSON. */
export function encodeTaskOutcome(outcome: TaskOutcome): string {
  const ordered: Record<string, string> = { state: outcome.state }
  for (const name of OUTCOME_FIELDS) {
    const value = outcome[name]
    if (value !== undefined) ordered[name] = value
  }
  return stringifyJson(ordered)
}

/** Decode a completion event's payload, refusing anything `encodeTaskOutcome` could not have written. */
export function decodeTaskOutcome(taskId: string, payloadJson: string): TaskOutcome {
  let parsed: unknown
  try {
    parsed = parseJson(payloadJson)
  } catch {
    throw new TrustedRangeError(`task ${taskId} has a completion event that is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TrustedRangeError(`task ${taskId} has a completion event that is not an object`)
  }
  const fields = parsed as Record<string, unknown>
  const state = hasOwn(fields, 'state') ? fields.state : undefined
  if (!isTerminalState(state)) {
    throw new TrustedRangeError(`task ${taskId} has a completion event with no terminal state`)
  }
  const result: TaskResult = { state }
  for (const name of OUTCOME_FIELDS) {
    const value = hasOwn(fields, name) ? fields[name] : undefined
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new TrustedRangeError(`task ${taskId} has a completion event whose ${name} is not text`)
    }
    result[name] = value
  }
  // The rule a task row is held to: a completed outcome carries its payload, a failed or
  // cancelled one its reason, and neither carries the other's.
  const contradiction = taskResultContradiction(result)
  if (contradiction !== null) {
    throw new TrustedRangeError(
      `task ${taskId} has a completion event that says it is ${state} but ${contradiction}`,
    )
  }
  return result as TaskOutcome
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
 * The idempotency key of the child a parent spawns at one call site. Only a store builds
 * it. Both strings are a caller's at the port and either may hold the delimiter, so the
 * parent id's length comes first, and no two pairs spell one key.
 */
export function childSpawnKey(parentTaskId: string, replayKey: string): string {
  return `${RESERVED_EVENT_PREFIX}spawn:${parentTaskId.length}:${parentTaskId}:${replayKey}`
}

/**
 * Refuse a caller's idempotency key in the engine's namespace. `ctx.spawn` keys its
 * children there, and the spawn receipt adopts whatever task holds a key, so a caller
 * who could take one would hand a parent a task of its own choosing as its child.
 */
export function refuseReservedIdempotencyKey(operation: string, key: string): void {
  if (startsWith(key, RESERVED_EVENT_PREFIX)) {
    throw new PortRefusalError(
      `${operation} idempotencyKey '${key}' is reserved: keys that start with '${RESERVED_EVENT_PREFIX}' belong to the engine`,
    )
  }
}

/**
 * The key a spawn stores: the caller's, the engine's for a child, or none. Every
 * dialect decides it here, so the reserved namespace has one door.
 */
export function spawnIdempotencyKey(opts: SpawnOptions): string | null {
  const callerKey = opts.idempotencyKey
  const childOf = opts.childOf
  if (childOf !== undefined) {
    if (callerKey !== undefined) {
      throw new PortRefusalError('spawn takes idempotencyKey or childOf, never both')
    }
    requireDurableString('childOf.parentQueue', childOf.parentQueue)
    requireDurableString('childOf.runId', childOf.runId)
    requireDurableString('childOf.claimToken', childOf.claimToken)
    const childKey = childSpawnKey(
      requireDurableString('childOf.parentTaskId', childOf.parentTaskId),
      requireDurableString('childOf.replayKey', childOf.replayKey),
    )
    // The key is built from the parent's task and the call site, so the width is held to
    // the key as it will be stored, which holds the parent's task id with it, and to the
    // parent's queue and run. A child spawn passes no idempotency key, so its refusal
    // names the replay key it did pass.
    requireIdentifiersFit({
      'childOf.parentQueue': childOf.parentQueue,
      'childOf.runId': childOf.runId,
      'childOf.replayKey, as the stored child key, which also holds the parent task id,': childKey,
    })
    return childKey
  }
  if (callerKey === undefined) return null
  const key = requireDurableString('idempotencyKey', callerKey)
  refuseReservedIdempotencyKey('spawn', key)
  requireIdentifiersFit({ idempotencyKey: key })
  return key
}

/**
 * The task of each run a store instance has handed out, so a terminal batch can name
 * its task's completion event without a read. `complete` and `fail` are handed only
 * the run, and the worker that calls them activated the run through the same store a
 * moment earlier. A run's task never changes and run ids are never reused, so an entry
 * cannot go stale, and a miss only costs the read. A store lets a run go once its own
 * terminal batch has ended it, so what is held is the runs still at work, and only a
 * store with more of those than the capacity loses one early. The oldest leaves first.
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

  /** Let a run go. Its terminal batch has ended it, so its own worker asks no more. */
  forget(runId: string): void {
    this.#tasks.delete(runId)
  }

  /** The run's task, if this store handed the run out and has not yet let the entry go. */
  recall(runId: string): string | undefined {
    return this.#tasks.get(runId)
  }
}

/**
 * Why an await of `childTaskId` from `queue` is refused, from the queue its task row
 * was read in, or null when the rule allows it. Every dialect classifies here.
 */
export function childAwaitRefusal(
  queue: string,
  childTaskId: string,
  childQueue: unknown,
): ChildAwaitRefusedError | null {
  if (childQueue === queue) return null
  return new ChildAwaitRefusedError(
    childTaskId,
    childQueue === undefined ? 'no-such-task' : 'other-queue',
  )
}

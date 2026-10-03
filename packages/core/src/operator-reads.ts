import { parseChildSpawnKey } from './child-tasks.js'
import { type FencedBatch, type FencedResult, readRows } from './fenced-batch.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import {
  OPERATOR_READ_METHODS,
  type OperatorReadMethod,
  requireOperatorReadStrings,
} from './port-strings.js'
import type { OperatorReads } from './ports.js'
import type { SqlRow } from './primitives.js'
import { decodeRollbackOutcome } from './sagas.js'
import type { SqlFragment } from './sql-tree.js'
import {
  eventStateRead,
  taskFactsRunsRead,
  taskFactsTaskRead,
  taskFactsWaitsRead,
  taskIdByKeyRead,
} from './statements/operator.js'
import { decodeTaskResult } from './task-result.js'
import type {
  AwaitedEventFacts,
  CorruptInteger,
  EventState,
  RunFacts,
  TaskFacts,
  TaskOutcomeFacts,
  WaitFacts,
} from './types.js'
import {
  type BrandedIntegerBounds,
  DERIVED_INTEGER_BOUNDS,
  PERSISTED_INTEGER_BOUNDS,
  decodeBoundedInteger,
  storageValueKind,
} from './validate.js'

const {
  ObjectCreate: createObject,
  ObjectFreeze: freeze,
  ObjectKeys: objectKeys,
  PromiseReject: rejected,
  RangeError: TrustedRangeError,
  ReflectApply: apply,
  StringFrom: stringFrom,
} = TASK_INTRINSICS

/**
 * What a dialect supplies to the operator's reads. Each member is a fact of the dialect:
 * its batches and how it runs one, its read of the test clock, and three fragments. The
 * statements, the decoding, the order of every list and the check of every string are
 * core's, so a dialect inherits them and cannot write them another way.
 *
 * A dialect opens each batch itself and runs it itself, as it does for `TaskDoneDialect`,
 * so every batch label stays a literal at a construction site in a store, and every batch
 * reaches the executor from a store: that is where the label ledger, the batch lint and
 * the fault matrix read them.
 */
export interface OperatorReadsDialect {
  /** Run a batch this dialect opened against its executor. */
  run(batch: FencedBatch): Promise<FencedResult>
  readonly open: {
    /** `task-facts`, a batch of reads. */
    taskFacts(): FencedBatch
    /** `task-id-by-key`, a batch of one read. */
    taskIdByKey(): FencedBatch
    /** `event-state`, a batch of one read. */
    eventState(): FencedBatch
  }
  /**
   * `fake-clock`: whether the store's test clock is set, as the integer 1 or 0. It is a
   * batch of its own and the dialect's own text, because a statement tree holds the clock
   * only as its token and may not name the test clock's row.
   */
  fakeClock(): Promise<unknown>
  /** The saga of the row `tasks` began. */
  readonly sagaBegan: SqlFragment
  /** The two values `decodeRollbackOutcome` reads of the row `tasks`, as `task-result` takes them. */
  readonly rollbackOutcome: SqlFragment
  readonly rollbackError: SqlFragment
}

const TASK = PERSISTED_INTEGER_BOUNDS.tasks
const RUN = PERSISTED_INTEGER_BOUNDS.runs
const WAIT = PERSISTED_INTEGER_BOUNDS.waits
const EVENT = PERSISTED_INTEGER_BOUNDS.events

/** A flag a statement computes: the integer 1 or 0. */
const FLAG = freeze({ min: 0, max: 1 })

/** The row an integer was read from, as a corrupt entry names it. */
type RowIdentity = Pick<CorruptInteger, 'runId' | 'stepName' | 'eventName'>

/**
 * The reader of one row's integers. Each is held to the bounds of its own field. A value
 * outside them, or one that is no exact integer, is listed in `corrupt` with the row it
 * came from and read as null. NULL reads as null and is listed nowhere: a column that may
 * hold none says so, and a schema refuses it in one that may not.
 */
function integersOf(row: SqlRow, corrupt: CorruptInteger[], identity: RowIdentity = {}) {
  return (
    bounds: BrandedIntegerBounds<string>,
    column = bounds.field.slice(bounds.field.indexOf('.') + 1),
  ): number | null => {
    const value = row[column]
    // A statement that did not select the column is a defect here, never a stored NULL.
    if (value === undefined) throw new TypeError(`an operator read selected no ${column}`)
    if (value === null) return null
    const decoded = decodeBoundedInteger(value, bounds)
    if (decoded.ok) return decoded.value
    const found = { reason: decoded.reason, stored: storageValueKind(value) }
    corrupt[corrupt.length] =
      typeof value === 'number' || typeof value === 'bigint'
        ? { field: bounds.field, ...identity, ...found, value: stringFrom(value) }
        : { field: bounds.field, ...identity, ...found }
    return null
  }
}

/**
 * A flag a statement computed. A dialect that answers it as anything but the integer 1 or
 * 0 is refused, because a string read as true would say a saga began that did not.
 */
function flagOf(what: string, value: unknown): boolean {
  const decoded = decodeBoundedInteger(value, FLAG)
  if (!decoded.ok) {
    throw new TrustedRangeError(
      `${what} must be the integer 0 or 1, got ${storageValueKind(value)}`,
    )
  }
  return decoded.value === 1
}

const textOf = (value: unknown): string | null =>
  value === null || value === undefined ? null : stringFrom(value)

/** The order of two strings by their UTF-16 code units, which no database collation decides. */
const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** A number that may be absent, with the absent ones last. */
const absentLast = (left: number | null, right: number | null): number =>
  left === right ? 0 : left === null ? 1 : right === null ? -1 : left - right

/**
 * A task's outcome, by the two decoders `getTaskResult` calls. What they refuse becomes the
 * answer, and only that: the catch holds the decoders alone, because core refuses some of a
 * caller's mistakes with a RangeError too, and those must stay errors.
 */
function outcomeOf(taskId: string, row: SqlRow): TaskOutcomeFacts {
  try {
    const result = decodeTaskResult(taskId, row)
    const rollback = decodeRollbackOutcome(taskId, row)
    return { result: rollback === undefined ? result : { ...result, rollback } }
  } catch (error) {
    if (!(error instanceof TrustedRangeError)) throw error
    return { refused: error.message }
  }
}

/** The events a task's runs and waits name, each read once, from the rows that joined it. */
function eventCollector(corrupt: CorruptInteger[]) {
  const found = createObject(null) as Record<string, AwaitedEventFacts>
  return {
    /** A row of a run or a wait, the event it names, and the event's own row joined to it. */
    add(named: unknown, row: SqlRow): void {
      const eventName = textOf(named)
      if (eventName === null || found[eventName] !== undefined) return
      const exists = row.emitted_event !== null
      found[eventName] = {
        eventName,
        exists,
        emittedAtMs: exists ? integersOf(row, corrupt, { eventName })(EVENT.emitted_at_ms) : null,
      }
    },
    sorted: (): AwaitedEventFacts[] =>
      objectKeys(found)
        .sort(byCodeUnits)
        .map((eventName) => found[eventName] as AwaitedEventFacts),
  }
}

async function taskFacts(
  dialect: OperatorReadsDialect,
  queue: string,
  taskId: string,
): Promise<TaskFacts | null> {
  const b = dialect.open.taskFacts()
  b.readTree(
    'task',
    taskFactsTaskRead({
      queue,
      taskId,
      sagaBegan: dialect.sagaBegan,
      rollbackOutcome: dialect.rollbackOutcome,
      rollbackError: dialect.rollbackError,
    }),
  )
  b.readTree('runs', taskFactsRunsRead({ taskId }))
  b.readTree('waits', taskFactsWaitsRead({ taskId }))
  const ran = await dialect.run(b)
  const task = readRows(b, ran, 'task')[0]
  if (task === undefined) return null
  // After the snapshot, and only for a task that exists: the flag says what clock the
  // snapshot's database time was read from.
  const fakeClock = flagOf('fake-clock', await dialect.fakeClock())

  const corrupt: CorruptInteger[] = []
  const events = eventCollector(corrupt)
  const ofTask = integersOf(task, corrupt)
  const key = textOf(task.idempotency_key)

  const runs = readRows(b, ran, 'runs').map((row): RunFacts => {
    const runId = stringFrom(row.run_id)
    const int = integersOf(row, corrupt, { runId })
    events.add(row.wake_event, row)
    return {
      runId,
      queue: stringFrom(row.queue),
      state: stringFrom(row.state),
      attempt: int(RUN.attempt),
      claimGen: int(RUN.claim_gen),
      activatedGen: int(RUN.activated_gen),
      relaunchCount: int(RUN.relaunch_count),
      claimExpiresAtMs: int(RUN.claim_expires_at_ms),
      heartbeatAtMs: int(RUN.heartbeat_at_ms),
      availableAtMs: int(RUN.available_at_ms),
      wakeEvent: textOf(row.wake_event),
      wakeStep: textOf(row.wake_step),
      startedAtMs: int(RUN.started_at_ms),
      completedAtMs: int(RUN.completed_at_ms),
      failedAtMs: int(RUN.failed_at_ms),
    }
  })
  const waits = readRows(b, ran, 'waits').map((row): WaitFacts => {
    const runId = stringFrom(row.run_id)
    const stepName = stringFrom(row.step_name)
    const int = integersOf(row, corrupt, { runId, stepName })
    events.add(row.event_name, row)
    return {
      runId,
      stepName,
      eventName: stringFrom(row.event_name),
      status: stringFrom(row.status),
      timeoutAtMs: int(WAIT.timeout_at_ms),
      createdAtMs: int(WAIT.created_at_ms),
    }
  })

  return {
    nowMs: ofTask(DERIVED_INTEGER_BOUNDS.epoch_ms, 'now_ms'),
    fakeClock,
    task: {
      taskId,
      queue,
      taskName: stringFrom(task.task_name),
      state: stringFrom(task.state),
      attempts: ofTask(TASK.attempts),
      maxAttempts: ofTask(TASK.max_attempts),
      infraRetries: ofTask(TASK.infra_retries),
      enqueueAtMs: ofTask(TASK.enqueue_at_ms),
      firstStartedAtMs: ofTask(TASK.first_started_at_ms),
      cancelAtMs: ofTask(TASK.cancel_at_ms),
      idempotencyKey: key,
      parentTaskId: key === null ? null : (parseChildSpawnKey(key)?.parentTaskId ?? null),
      sagaBegan: flagOf('task-facts saga_began', task.saga_began),
    },
    outcome: outcomeOf(taskId, task),
    runs: runs.sort(
      (left, right) =>
        absentLast(left.attempt, right.attempt) || byCodeUnits(left.runId, right.runId),
    ),
    waits: waits.sort(
      (left, right) =>
        byCodeUnits(left.runId, right.runId) || byCodeUnits(left.stepName, right.stepName),
    ),
    events: events.sorted(),
    corrupt: sortedCorrupt(corrupt),
  }
}

/** The corrupt list in one order whatever order a dialect returned its rows in. */
function sortedCorrupt(corrupt: CorruptInteger[]): CorruptInteger[] {
  const place = (entry: CorruptInteger): string[] => [
    entry.field,
    entry.runId ?? '',
    entry.stepName ?? '',
    entry.eventName ?? '',
  ]
  return corrupt.sort((left, right) => {
    const [from, to] = [place(left), place(right)]
    for (let index = 0; index < from.length; index++) {
      const order = byCodeUnits(from[index] as string, to[index] as string)
      if (order !== 0) return order
    }
    return 0
  })
}

async function taskIdByKey(
  dialect: OperatorReadsDialect,
  queue: string,
  idempotencyKey: string,
): Promise<string | null> {
  const b = dialect.open.taskIdByKey()
  b.readTree('task', taskIdByKeyRead({ queue, idempotencyKey }))
  const row = readRows(b, await dialect.run(b), 'task')[0]
  return row === undefined ? null : stringFrom(row.task_id)
}

async function eventState(
  dialect: OperatorReadsDialect,
  queue: string,
  eventName: string,
): Promise<EventState> {
  const b = dialect.open.eventState()
  b.readTree('event', eventStateRead({ queue, eventName }))
  const row = readRows(b, await dialect.run(b), 'event')[0]
  if (row === undefined) return { exists: false, emittedAtMs: null, corrupt: [] }
  const corrupt: CorruptInteger[] = []
  const emittedAtMs = integersOf(row, corrupt, { eventName })(EVENT.emitted_at_ms)
  return { exists: true, emittedAtMs, corrupt }
}

/**
 * The operator's read port over one dialect, and the only implementation of it. Every
 * method the string table names is reached through `requireOperatorReadStrings`, put in
 * front of it here in one loop, so no method can leave the check out, and a method the
 * port gains is checked once the table names its strings, which the table's type makes it
 * do. A refusal is a rejected promise, as a store's is.
 */
export function createOperatorReads(dialect: OperatorReadsDialect): OperatorReads {
  const entries: OperatorReads = {
    taskFacts: (queue, taskId) => taskFacts(dialect, queue, taskId),
    taskIdByKey: (queue, idempotencyKey) => taskIdByKey(dialect, queue, idempotencyKey),
    eventState: (queue, eventName) => eventState(dialect, queue, eventName),
  }
  const held: Partial<Record<OperatorReadMethod, unknown>> = {}
  for (let index = 0; index < OPERATOR_READ_METHODS.length; index++) {
    const method = OPERATOR_READ_METHODS[index]
    if (method === undefined) continue
    const entry: (...args: never[]) => Promise<unknown> = entries[method]
    held[method] = (...args: unknown[]): Promise<unknown> => {
      try {
        requireOperatorReadStrings(method, args)
      } catch (error) {
        return rejected(error)
      }
      return apply(entry, undefined, args)
    }
  }
  return freeze(held) as OperatorReads
}

import { parseChildSpawnKey } from './child-tasks.js'
import { OPERATOR_GAUGE_CAP, OPERATOR_LIST_CAP, OPERATOR_TABLE_ROWS_CAP } from './contract.js'
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
  type RunInstant,
  databaseNowRead,
  eventPayloadRead,
  eventStateRead,
  eventWaitersRead,
  liveTaskInstantsRead,
  liveTasksRead,
  overdueCancelsRead,
  overdueRunsRead,
  overdueRunsWindowRead,
  overdueTasksWindowRead,
  runInstantsRead,
  tableRowsRead,
  taskAdmissionRetryRead,
  taskAdmissionRunsRead,
  taskAdmissionSweepRead,
  taskDeadlinesRead,
  taskFactsRunsRead,
  taskFactsTaskRead,
  taskFactsWaitsRead,
  taskIdByKeyRead,
} from './statements/operator.js'
import {
  RETRY_CONJUNCT_COMPUTES_WITH,
  RETRY_GUARD,
  type RetryConjuncts,
  type RetryGuardConjunct,
} from './statements/retry-task.js'
import { QUEUE_TABLES, type QueueTable, STORE_TABLE_COLUMNS } from './store-tables.js'
import { decodeTaskResult } from './task-result.js'
import type {
  AgedTasks,
  AgedTasksOptions,
  AwaitedEventFacts,
  Capped,
  CorruptInteger,
  EmittedEvent,
  EventState,
  EventWaiter,
  EventWaiters,
  Gauge,
  LapsedRun,
  OverdueRun,
  OverdueTask,
  QueueStatus,
  RunAdmission,
  RunFacts,
  StoredEventPayload,
  StuckRuns,
  StuckRunsOptions,
  TableRows,
  TaskAdmission,
  TaskFacts,
  TaskOutcomeFacts,
  UnadmittedRun,
  UncancelledTask,
  UnreclaimedRun,
  WaitFacts,
  Windowed,
} from './types.js'
import {
  DERIVED_INTEGER_BOUNDS,
  type IntegerBounds,
  PERSISTED_INTEGER_BOUNDS,
  PERSISTED_INTEGER_NEVER_NULL,
  type PersistedIntegerBounds,
  decodeBoundedInteger,
  durationToMs,
  persistedIntegerColumn,
  requirePositiveInt,
  storageValueKind,
} from './validate.js'

const {
  ObjectCreate: createObject,
  ObjectFreeze: freeze,
  ObjectKeys: objectKeys,
  PromiseReject: rejected,
  RangeError: TrustedRangeError,
  ReflectApply: apply,
  StringCharCodeAt: charCodeAt,
  StringFrom: stringFrom,
} = TASK_INTRINSICS

/**
 * What a dialect supplies to the operator's reads. Each member is a fact of the dialect:
 * its batches and how it runs one, its read of the test clock, and its fragments. The
 * statements, the decoding, the order of every list and the check of every string are
 * core's, so a dialect inherits them: what `createOperatorReads` returns is the only value
 * of the held type, which is the type a store's factory hands out.
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
    /** `stuck-runs`, a batch of reads. */
    stuckRuns(): FencedBatch
    /** `queue-status`, a batch of reads. */
    queueStatus(): FencedBatch
    /** `table-rows`, a batch of reads. */
    tableRows(): FencedBatch
    /** `event-waiters`, a batch of one read. */
    eventWaiters(): FencedBatch
    /** `aged-tasks`, a batch of reads. */
    agedTasks(): FencedBatch
    /** `event-payload`, a batch of one read. */
    eventPayload(): FencedBatch
    /** `task-admission`, a batch of reads. */
    taskAdmission(): FencedBatch
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
  /** The task `t` owns the run `r`. */
  readonly taskOwnsRun: SqlFragment
  /** The run `r` is a live run of the task `t`. */
  readonly liveRunOfTask: SqlFragment
  /** How this dialect names the type of the stored value of `payload`, as its `emit-event` reads it. */
  readonly storedPayloadType: SqlFragment
  /**
   * The conjuncts this store's retry guard is built from (`retryAdmission`), each over the
   * row `tasks`. A store hands out the record its `retryTask` holds, so the flags of
   * `task-admission` cannot mean anything the guard does not.
   */
  readonly retryConjuncts: RetryConjuncts
  /**
   * What the engine would take now, each as the predicate the engine's own statement holds,
   * with the queue bound: over a run `r` and its task `t`, a claim's candidates of one
   * state and the sweep's expired claims, and over a task `t`, the sweep's due
   * cancellations. A store hands out the predicate its claim and its sweep are built from,
   * so a leg of `stuck-runs` cannot mean anything the engine does not.
   */
  readonly owed: {
    pendingRuns(queue: string): SqlFragment
    sleepingRuns(queue: string): SqlFragment
    expiredClaims(queue: string): SqlFragment
    dueCancels(queue: string): SqlFragment
  }
  /**
   * The same rows by their instant alone, with the queue bound, before anything the claim
   * or the sweep requires of them: over a run `r`, the due runs of one state and the
   * running runs whose lease has expired, and over a task `t`, the live tasks past their
   * cancellation deadline, in one leg or several as an index hands them out in the order
   * of the deadline. `stuck-runs` reads a window of the oldest of each.
   */
  readonly overdue: {
    pendingRuns(queue: string): SqlFragment
    sleepingRuns(queue: string): SqlFragment
    lapsedLeases(queue: string): SqlFragment
    passedDeadlines(queue: string): readonly SqlFragment[]
  }
  /**
   * The rows each leg of `queue-status` counts, with the queue bound: over a run `r`, the
   * runs of one state whose instant is stored at all, and over a task `t`, the live tasks
   * whose cancellation deadline is. None holds its instant to bounds.
   */
  readonly counted: {
    pendingRuns(queue: string): SqlFragment
    sleepingRuns(queue: string): SqlFragment
    runningRuns(queue: string): SqlFragment
    /**
     * One leg or several, each a predicate whose rows an index hands out in the order of
     * the deadline: a dialect whose index of deadlines leads with the state reads each
     * live state as a leg of its own.
     */
    tasksWithADeadline(queue: string): readonly SqlFragment[]
    /**
     * The live tasks, over a task `t`, one leg to a live state: each a predicate whose rows
     * the index of live tasks hands out in the order they were enqueued.
     */
    liveTasks(queue: string): readonly SqlFragment[]
  }
}

declare const heldOperatorReads: unique symbol

/**
 * The operator's reads with the check of every string in front of every method. The type
 * is nominal and `createOperatorReads` alone makes a value of it, so an object that
 * implements `OperatorReads` on its own does not type as one. A store's factory hands this
 * out, and the conformance fixture and the CLI's opener take nothing less, as they take a
 * store only through `HeldPort`.
 */
export type HeldOperatorReads = OperatorReads & { readonly [heldOperatorReads]: true }

const TASK = PERSISTED_INTEGER_BOUNDS.tasks
const RUN = PERSISTED_INTEGER_BOUNDS.runs
const WAIT = PERSISTED_INTEGER_BOUNDS.waits
const EVENT = PERSISTED_INTEGER_BOUNDS.events

/** A flag a statement computes: the integer 1 or 0. */
const FLAG = freeze({ min: 0, max: 1 })

/** A conjunct asked only of some rows: 1 or 0 where it was asked, and 2 where it was not. */
const ASKED_FLAG = freeze({ min: 0, max: 2 })

/** The row an integer was read from, as a corrupt entry names it. */
type RowIdentity = Pick<CorruptInteger, 'taskId' | 'runId' | 'stepName' | 'eventName'>

/** The one persisted integer whose column may hold NULL and whose rows never do, as core names it. */
const WRITTEN_WITH_EVERY_ROW: PersistedIntegerBounds = PERSISTED_INTEGER_NEVER_NULL

/**
 * Whether a persisted integer's column may hold NULL by its schema, by field, for the
 * tables `STORE_TABLE_COLUMNS` names, which a conformance case holds equal to every
 * dialect's catalog. It is built once. A persisted integer of one of those tables that no
 * statement builder names stops this module loading. The integers of `drivers` are not
 * here, because no statement builder names that table, and a read of one would be refused
 * where it asks below. The second half of the check in the loop is for the type checker: a
 * key of `fields` always has a value.
 */
const SCHEMA_STORES_NULL = ((): Readonly<Record<string, boolean>> => {
  const stores = createObject(null) as Record<string, boolean>
  const tables = objectKeys(STORE_TABLE_COLUMNS) as (keyof typeof STORE_TABLE_COLUMNS)[]
  for (const table of tables) {
    const columns: Readonly<Record<string, { readonly nullable: boolean }>> =
      STORE_TABLE_COLUMNS[table]
    const fields: Readonly<Record<string, { readonly field: string }>> =
      PERSISTED_INTEGER_BOUNDS[table]
    for (const column of objectKeys(fields)) {
      const spec = columns[column]
      const bounds = fields[column]
      if (spec === undefined || bounds === undefined) {
        throw new TypeError(`no statement builder names the column ${table}.${column}`)
      }
      stores[bounds.field] = spec.nullable
    }
  }
  return freeze(stores)
})()

/**
 * Whether a stored NULL is a value of a persisted integer, or a corrupt one. The column's
 * schema answers for every column but the one above. The reads ask here. Their conformance
 * surface writes that one exception out itself, so its cases can fail when this is wrong.
 */
function storedNullIsAValue(bounds: PersistedIntegerBounds): boolean {
  if (bounds === WRITTEN_WITH_EVERY_ROW) return false
  const stores = SCHEMA_STORES_NULL[bounds.field]
  if (stores === undefined) {
    throw new TypeError(`no statement builder names the column ${bounds.field}`)
  }
  return stores
}

/**
 * The reader of one row's integers. Each is held to the bounds of its own field. A value
 * outside them, or one that is no exact integer, is listed in `corrupt` with the row it
 * came from and read as null. A stored NULL is read as null and listed nowhere where it is
 * a value of the field (`storedNullIsAValue`), and is listed like any other corrupt value
 * where it is not.
 */
function integersOf(row: SqlRow, corrupt: CorruptInteger[], identity: RowIdentity = {}) {
  /** One value of the row, held to bounds, and listed under `field` when they refuse it. */
  const held = (
    field: string,
    column: string,
    bounds: IntegerBounds,
    nullIsAValue: boolean,
  ): number | null => {
    const value = row[column]
    // A statement that did not select the column is a defect here, never a stored NULL.
    if (value === undefined) throw new TypeError(`an operator read selected no ${column}`)
    if (value === null && nullIsAValue) return null
    const decoded = decodeBoundedInteger(value, bounds)
    if (decoded.ok) return decoded.value
    corrupt[corrupt.length] = {
      field,
      ...identity,
      reason: decoded.reason,
      stored: storageValueKind(value),
      ...(typeof value === 'number' || typeof value === 'bigint'
        ? { value: stringFrom(value) }
        : {}),
    }
    return null
  }
  return Object.assign(
    /** A persisted field, read from the column its bounds are for. */
    (bounds: PersistedIntegerBounds) =>
      held(bounds.field, persistedIntegerColumn(bounds), bounds, storedNullIsAValue(bounds)),
    /**
     * Database time, which no column stores and which is never NULL: the statement names
     * where it selected it.
     */
    {
      now: (column: string) =>
        held(DERIVED_INTEGER_BOUNDS.epoch_ms.field, column, DERIVED_INTEGER_BOUNDS.epoch_ms, false),
    },
  )
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

/**
 * A conjunct that is asked only where its counters are in range. Its statement answers 2
 * for a row it was not asked of, which is neither that it holds nor that it does not.
 */
function askedFlag(what: string, value: unknown): boolean | 'not-asked' {
  const decoded = decodeBoundedInteger(value, ASKED_FLAG)
  if (!decoded.ok) {
    throw new TrustedRangeError(
      `${what} must be the integer 0, 1 or 2, got ${storageValueKind(value)}`,
    )
  }
  return decoded.value === 2 ? 'not-asked' : decoded.value === 1
}

const textOf = (value: unknown): string | null =>
  value === null || value === undefined ? null : stringFrom(value)

/**
 * Where a UTF-16 code unit stands in code point order. A surrogate is half of a character
 * past the basic plane, and such a character sorts after every character of the plane, so
 * the surrogates move above U+E000 to U+FFFF and those move down into the gap.
 */
const codePointRank = (unit: number): number =>
  unit < 0xd800 ? unit : unit < 0xe000 ? unit + 0x2000 : unit - 0x800

/**
 * The order of two strings by Unicode code point, which is the order of their UTF-8 bytes.
 * No database collation decides it, and an implementation whose strings are UTF-8 gets the
 * same order from a plain comparison of bytes.
 */
export function byCodePoints(left: string, right: string): number {
  const shared = left.length < right.length ? left.length : right.length
  for (let index = 0; index < shared; index++) {
    const leftUnit = charCodeAt(left, index)
    const rightUnit = charCodeAt(right, index)
    if (leftUnit !== rightUnit) return codePointRank(leftUnit) - codePointRank(rightUnit)
  }
  return left.length - right.length
}

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

const NOT_EMITTED: Extract<EmittedEvent, { exists: false }> = freeze({
  exists: false,
  emittedAtMs: null,
})

/**
 * An event's own row, however a statement reached it: joined to a run or a wait that names
 * the event, or selected by its key. Both reads decode its instant here.
 */
const emittedEvent = (
  row: SqlRow,
  corrupt: CorruptInteger[],
  eventName: string,
): Extract<EmittedEvent, { exists: true }> => ({
  exists: true,
  emittedAtMs: integersOf(row, corrupt, { eventName })(EVENT.emitted_at_ms),
})

/** The events a task's runs and waits name, each read once, from the rows that joined it. */
function eventCollector(corrupt: CorruptInteger[]) {
  const found = createObject(null) as Record<string, AwaitedEventFacts>
  return {
    /** A row of a run or a wait, the event it names, and the event's own row joined to it. */
    add(named: unknown, row: SqlRow): void {
      const eventName = textOf(named)
      if (eventName === null || found[eventName] !== undefined) return
      found[eventName] = {
        eventName,
        ...(row.emitted_event === null ? NOT_EMITTED : emittedEvent(row, corrupt, eventName)),
      }
    },
    sorted: (): AwaitedEventFacts[] =>
      objectKeys(found)
        .sort(byCodePoints)
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
    nowMs: ofTask.now('now_ms'),
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
        absentLast(left.attempt, right.attempt) || byCodePoints(left.runId, right.runId),
    ),
    waits: waits.sort(
      (left, right) =>
        byCodePoints(left.runId, right.runId) || byCodePoints(left.stepName, right.stepName),
    ),
    events: events.sorted(),
    corrupt: corrupt.sort(corruptOrder),
  }
}

/** The order of the corrupt list: by field and then by row, whatever order the rows were read in. */
const corruptOrder = (left: CorruptInteger, right: CorruptInteger): number =>
  byCodePoints(left.field, right.field) ||
  byCodePoints(left.taskId ?? '', right.taskId ?? '') ||
  byCodePoints(left.runId ?? '', right.runId ?? '') ||
  byCodePoints(left.stepName ?? '', right.stepName ?? '') ||
  byCodePoints(left.eventName ?? '', right.eventName ?? '')

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
  if (row === undefined) return { ...NOT_EMITTED, corrupt: [] }
  const corrupt: CorruptInteger[] = []
  return { ...emittedEvent(row, corrupt, eventName), corrupt }
}

/**
 * Why the statements of one report may see different clocks, the reason `readTree` asks of
 * every read of the clock after a batch's first. Each leg holds the engine's own predicate
 * at the instant of its own statement. The report's time is read by its last statement, so
 * no leg saw a later clock than the one its rows are dated against.
 */
export const OPERATOR_REPORT_DRIFT =
  'read-only report: each leg holds what the engine would take at the instant of its own statement, and the last statement reads the time the report is dated by'

/** A report's corrupt entries in the one order every list of them has. */
const inOrder = (corrupt: CorruptInteger[]): CorruptInteger[] => corrupt.sort(corruptOrder)

/** A count that stops at a cap. Past the cap it is the cap, and `atLeast` says more rows exist. */
const gaugeOf = (counted: number, cap: number): Gauge =>
  counted > cap ? { count: cap, atLeast: true } : { count: counted, atLeast: false }

/** The most rows a leg may be asked for, refused as a store refuses a number it cannot take. */
export function requireListLimit(limit: number): number {
  if (requirePositiveInt('limit', limit) > OPERATOR_LIST_CAP) {
    throw new TrustedRangeError(`limit must be at most ${OPERATOR_LIST_CAP}, got ${limit}`)
  }
  return limit
}

/**
 * Database time as the last statement of a report read it. A batch that answers no row for
 * it is a defect of the dialect, never an empty queue.
 */
function reportTime(b: FencedBatch, ran: FencedResult, corrupt: CorruptInteger[]): number | null {
  const row = readRows(b, ran, 'now')[0]
  if (row === undefined) throw new TypeError('an operator read answered no row for database time')
  return integersOf(row, corrupt).now('now_ms')
}

/**
 * The rows of one list whose instant is at least `agedMs` behind database time, oldest
 * first, up to the limit, each with how far behind its instant is. A list is read oldest
 * first and one row past the limit, so the rows `agedMs` admits are the first of what was
 * read, and `atLeast` says exactly whether more exist. A row whose instant is not readable
 * is listed whatever `agedMs` is, and so is every row when database time is not: nothing
 * says such a row is newer than that.
 */
/**
 * Whether an instant is at least `agedMs` behind database time. One that is not readable
 * is taken to be, and so is every instant when database time is not: nothing says such a
 * row is newer than that.
 */
const agedAt = (at: number | null, nowMs: number | null, agedMs: number): boolean =>
  at === null || nowMs === null || at <= nowMs - agedMs

function agedBy<Row>(
  read: readonly Row[],
  instantOf: (row: Row) => number | null,
  idOf: (row: Row) => string,
  nowMs: number | null,
  agedMs: number,
  limit: number,
): Capped<{ readonly row: Row; readonly byMs: number | null }> {
  const aged = read
    .map((row) => ({ row, at: instantOf(row) }))
    .filter((one) => agedAt(one.at, nowMs, agedMs))
    .sort(
      (left, right) =>
        absentLast(left.at, right.at) || byCodePoints(idOf(left.row), idOf(right.row)),
    )
    .map(({ row, at }) => ({ row, byMs: at === null || nowMs === null ? null : nowMs - at }))
  return { rows: aged.slice(0, limit), atLeast: aged.length > limit }
}

/**
 * The rows of one leg whose move has been owed for at least the grace, oldest first, up to
 * the limit, each with how late its move is (`agedBy`).
 */
function owedFor<Row extends { readonly dueAtMs: number | null }>(
  read: readonly Row[],
  idOf: (row: Row) => string,
  nowMs: number | null,
  graceMs: number,
  limit: number,
): Capped<Row & { readonly lateByMs: number | null }> {
  const owed = agedBy(read, (row) => row.dueAtMs, idOf, nowMs, graceMs, limit)
  return {
    rows: owed.rows.map(({ row, byMs }) => ({ ...row, lateByMs: byMs })),
    atLeast: owed.atLeast,
  }
}

/**
 * The legs of a queue's live tasks, one read to a live state, each oldest first, under the
 * names answered. `read` is the statement of a leg: the one that lists a task, or the one
 * that selects only what a gauge counts.
 */
function liveTaskLegs(
  b: FencedBatch,
  legs: readonly SqlFragment[],
  limit: number,
  read: typeof liveTasksRead | typeof liveTaskInstantsRead,
): string[] {
  return legs.map((rows, leg) => {
    b.readTree(`live-${leg}`, read({ limit, rows }))
    return `live-${leg}`
  })
}

/** The live tasks the legs of `aged-tasks` read, each with its enqueue instant, null where the stored one is not readable. */
function liveTasksOf(
  b: FencedBatch,
  ran: FencedResult,
  legs: readonly string[],
  corrupt: CorruptInteger[],
) {
  return legs.flatMap((leg) =>
    readRows(b, ran, leg).map((row) => {
      const taskId = stringFrom(row.task_id)
      return {
        taskId,
        taskName: stringFrom(row.task_name),
        state: stringFrom(row.state),
        enqueueAtMs: integersOf(row, corrupt, { taskId })(TASK.enqueue_at_ms),
      }
    }),
  )
}

async function agedTasks(
  dialect: OperatorReadsDialect,
  queue: string,
  options: AgedTasksOptions,
): Promise<AgedTasks> {
  const olderThanMs = durationToMs('olderThanSeconds', options.olderThanSeconds)
  const limit = requireListLimit(options.limit)
  const b = dialect.open.agedTasks()
  // Each leg is read one row past the limit, so the oldest of them all are among the rows
  // read, and the list says whether it holds more than it lists.
  const legs = liveTaskLegs(b, dialect.counted.liveTasks(queue), limit + 1, liveTasksRead)
  b.readTree('now', databaseNowRead({}))
  const ran = await dialect.run(b)
  const fakeClock = flagOf('fake-clock', await dialect.fakeClock())

  const corrupt: CorruptInteger[] = []
  const nowMs = reportTime(b, ran, corrupt)
  const aged = agedBy(
    liveTasksOf(b, ran, legs, corrupt),
    (task) => task.enqueueAtMs,
    (task) => task.taskId,
    nowMs,
    olderThanMs,
    limit,
  )
  return {
    nowMs,
    fakeClock,
    tasks: {
      rows: aged.rows.map(({ row, byMs }) => ({ ...row, ageMs: byMs })),
      atLeast: aged.atLeast,
    },
    corrupt: inOrder(corrupt),
  }
}

/** A row's place in the order every leg is read in: its instant, and then its id. */
interface Placed {
  readonly id: string
  readonly at: number | null
}

const sortsBefore = (row: Placed, other: Placed): boolean =>
  (absentLast(row.at, other.at) || byCodePoints(row.id, other.id)) < 0

/**
 * One kind of row a leg lists, a run or a task: the column of a row read that holds its id,
 * the id of a row decoded, and the decoder, held together, so that a leg cannot be wired to
 * read the ids of one column and compare the places of another.
 */
interface OwedKind<Id, Row extends Id & { readonly dueAtMs: number | null }> {
  readonly idColumn: 'run_id' | 'task_id'
  idOf(row: Id): string
  decode(row: SqlRow, corrupt: CorruptInteger[]): Row
}

/**
 * The rows of a window that the engine does not take. `read` is the oldest rows by a leg's
 * instant alone, as many as the limit and two more. `taken` is what the engine's own
 * statement answered for the same instant, oldest first and one row past the limit. A row
 * read that `taken` does not hold is one the engine refuses when `taken` holds every row
 * the engine would take, or when the row sorts before the last row of `taken`: had the
 * engine admitted it, its statement would have answered it ahead of that one. A row that
 * sorts after the last of a full `taken` is not settled, and neither are rows past a read
 * that came back full. `unexamined` says that such a row could be one the leg lists:
 * `aged` is the leg's own test of the grace, and rows past a full read sort after its last
 * row, so they are old enough only when that row is. A row that is not settled is not
 * decoded into `corrupt`: the leg does not list it.
 */
function notTaken<Id, Row extends Id & { readonly dueAtMs: number | null }>(
  read: readonly SqlRow[],
  kind: OwedKind<Id, Row>,
  taken: readonly (Id & { readonly dueAtMs: number | null })[],
  corrupt: CorruptInteger[],
  limit: number,
  aged: (at: number | null) => boolean,
): { readonly rows: Row[]; readonly unexamined: boolean } {
  const placeOf = (row: Id & { readonly dueAtMs: number | null }): Placed => ({
    id: kind.idOf(row),
    at: row.dueAtMs,
  })
  const held = new Map(taken.map((row) => [kind.idOf(row), row.dueAtMs]))
  const lastTaken = taken[taken.length - 1]
  const last = taken.length > limit && lastTaken !== undefined ? placeOf(lastTaken) : undefined
  const rows: Row[] = []
  let unsettled = false
  let endsAt: number | null = null
  for (const raw of read) {
    const id = stringFrom(raw[kind.idColumn])
    if (held.has(id)) {
      endsAt = held.get(id) ?? null
      continue
    }
    const its: CorruptInteger[] = []
    const row = kind.decode(raw, its)
    endsAt = row.dueAtMs
    if (last === undefined || sortsBefore(placeOf(row), last)) {
      rows.push(row)
      corrupt.push(...its)
    } else if (aged(row.dueAtMs)) {
      unsettled = true
    }
  }
  const past = read.length > limit + 1 && aged(endsAt)
  return { rows, unexamined: unsettled || past }
}

async function stuckRuns(
  dialect: OperatorReadsDialect,
  queue: string,
  options: StuckRunsOptions,
): Promise<StuckRuns> {
  const graceMs = durationToMs('graceSeconds', options.graceSeconds)
  const limit = requireListLimit(options.limit)
  const { owed, overdue, taskOwnsRun, liveRunOfTask } = dialect
  const b = dialect.open.stuckRuns()
  // The windows first, and the engine's own legs after them. Each statement holds its
  // instant to the clock as it reads it, so a row a window read as owed is owed when the
  // engine's leg is read, and a row the leg does not answer was not left out for its time.
  const window = (rows: SqlFragment, dueAt: RunInstant) =>
    overdueRunsWindowRead({ limit: limit + 2, rows, dueAt })
  b.readTree('window-pending', window(overdue.pendingRuns(queue), 'available_at_ms'))
  b.readTree(
    'window-sleeping',
    window(overdue.sleepingRuns(queue), 'available_at_ms'),
    OPERATOR_REPORT_DRIFT,
  )
  b.readTree(
    'window-lapsed',
    window(overdue.lapsedLeases(queue), 'claim_expires_at_ms'),
    OPERATOR_REPORT_DRIFT,
  )
  const deadlineWindows = overdue.passedDeadlines(queue).map((rows, leg) => {
    b.readTree(
      `window-deadlines-${leg}`,
      overdueTasksWindowRead({ limit: limit + 2, rows }),
      OPERATOR_REPORT_DRIFT,
    )
    return `window-deadlines-${leg}`
  })
  // Each leg is read one row past the limit, so it says whether it holds more than it lists.
  const runs = (admitted: SqlFragment, dueAt: RunInstant) =>
    overdueRunsRead({ limit: limit + 1, taskOwnsRun, admitted, dueAt })
  b.readTree('pending', runs(owed.pendingRuns(queue), 'available_at_ms'), OPERATOR_REPORT_DRIFT)
  b.readTree('sleeping', runs(owed.sleepingRuns(queue), 'available_at_ms'), OPERATOR_REPORT_DRIFT)
  b.readTree(
    'lapsed',
    runs(owed.expiredClaims(queue), 'claim_expires_at_ms'),
    OPERATOR_REPORT_DRIFT,
  )
  b.readTree(
    'cancels',
    overdueCancelsRead({ limit: limit + 1, due: owed.dueCancels(queue), liveRunOfTask }),
    OPERATOR_REPORT_DRIFT,
  )
  b.readTree('now', databaseNowRead({}), OPERATOR_REPORT_DRIFT)
  const ran = await dialect.run(b)
  const fakeClock = flagOf('fake-clock', await dialect.fakeClock())

  const corrupt: CorruptInteger[] = []
  const nowMs = reportTime(b, ran, corrupt)
  /** The runs of one of the engine's legs, each with the instant its move came due at. */
  const runsOf = (leg: string, dueAt: PersistedIntegerBounds) =>
    readRows(b, ran, leg).map((row) => {
      const runId = stringFrom(row.run_id)
      const int = integersOf(row, corrupt, { runId })
      const ordinal = int(RUN.attempt)
      const run = {
        runId,
        taskId: stringFrom(row.task_id),
        taskName: stringFrom(row.task_name),
        attempt: ordinal,
        dueAtMs: int(dueAt),
      }
      return { run, int }
    })
  const pending = runsOf('pending', RUN.available_at_ms).map(({ run }) => run)
  const sleeping = runsOf('sleeping', RUN.available_at_ms).map(({ run }) => run)
  const lapsed = runsOf('lapsed', RUN.claim_expires_at_ms).map(({ run, int }) => {
    const claims = int(RUN.claim_gen)
    const activations = int(RUN.activated_gen)
    return {
      ...run,
      activated: claims === null || activations === null ? null : activations === claims,
    }
  })
  const cancels = readRows(b, ran, 'cancels').map((row) => {
    const taskId = stringFrom(row.task_id)
    return {
      taskId,
      taskName: stringFrom(row.task_name),
      state: stringFrom(row.state),
      runId: textOf(row.run_id),
      dueAtMs: integersOf(row, corrupt, { taskId })(TASK.cancel_at_ms),
    }
  })
  const byRun = (run: { readonly runId: string }): string => run.runId
  const byTask = (task: { readonly taskId: string }): string => task.taskId
  /** A run of a window, from the run's own row: the instant is the one its leg is read by. */
  const runsOwed = (dueAt: PersistedIntegerBounds) => ({
    idColumn: 'run_id' as const,
    idOf: byRun,
    decode: (row: SqlRow, into: CorruptInteger[]) => {
      const runId = stringFrom(row.run_id)
      const int = integersOf(row, into, { runId })
      const ordinal = int(RUN.attempt)
      return { runId, taskId: stringFrom(row.task_id), attempt: ordinal, dueAtMs: int(dueAt) }
    },
  })
  /** A task of a window of deadlines. */
  const tasksOwed = {
    idColumn: 'task_id' as const,
    idOf: byTask,
    decode: (row: SqlRow, into: CorruptInteger[]) => {
      const taskId = stringFrom(row.task_id)
      return {
        taskId,
        taskName: stringFrom(row.task_name),
        state: stringFrom(row.state),
        dueAtMs: integersOf(row, into, { taskId })(TASK.cancel_at_ms),
      }
    },
  }
  const dueRuns = runsOwed(RUN.available_at_ms)
  /** The leg's own test of the grace, which a row a window left unsettled is held to as well. */
  const aged = (at: number | null): boolean => agedAt(at, nowMs, graceMs)
  const pendingNotAdmitted = notTaken(
    readRows(b, ran, 'window-pending'),
    dueRuns,
    pending,
    corrupt,
    limit,
    aged,
  )
  const sleepingNotAdmitted = notTaken(
    readRows(b, ran, 'window-sleeping'),
    dueRuns,
    sleeping,
    corrupt,
    limit,
    aged,
  )
  const notReclaimed = notTaken(
    readRows(b, ran, 'window-lapsed'),
    runsOwed(RUN.claim_expires_at_ms),
    lapsed,
    corrupt,
    limit,
    aged,
  )
  const notCancelled = deadlineWindows.map((leg) =>
    notTaken(readRows(b, ran, leg), tasksOwed, cancels, corrupt, limit, aged),
  )
  /** One leg of what the engine does not take, from the windows that hold it, under the grace and the limit. */
  const windowed = <Row extends { readonly dueAtMs: number | null }>(
    windows: readonly { readonly rows: readonly Row[]; readonly unexamined: boolean }[],
    idOf: (row: Row) => string,
  ): Windowed<Row & { readonly lateByMs: number | null }> => ({
    ...owedFor(
      windows.flatMap((one) => one.rows),
      idOf,
      nowMs,
      graceMs,
      limit,
    ),
    unexamined: windows.some((one) => one.unexamined),
  })
  const inState = (
    found: typeof pendingNotAdmitted,
    state: UnadmittedRun['state'],
  ): typeof found & { readonly rows: Omit<UnadmittedRun, 'lateByMs'>[] } => ({
    rows: found.rows.map((run) => ({ ...run, state })),
    unexamined: found.unexamined,
  })
  const dueUnclaimed: Capped<OverdueRun> = owedFor(pending, byRun, nowMs, graceMs, limit)
  const sleepingPastWake: Capped<OverdueRun> = owedFor(sleeping, byRun, nowMs, graceMs, limit)
  const dueNotAdmitted: Windowed<UnadmittedRun> = windowed(
    [inState(pendingNotAdmitted, 'pending'), inState(sleepingNotAdmitted, 'sleeping')],
    byRun,
  )
  const leaseLapsed: Capped<LapsedRun> = owedFor(lapsed, byRun, nowMs, graceMs, limit)
  const lapsedNotReclaimed: Windowed<UnreclaimedRun> = windowed([notReclaimed], byRun)
  const cancelOverdue: Capped<OverdueTask> = owedFor(cancels, byTask, nowMs, graceMs, limit)
  const deadlineNotCancelled: Windowed<UncancelledTask> = windowed(notCancelled, byTask)
  return {
    nowMs,
    fakeClock,
    dueUnclaimed,
    sleepingPastWake,
    dueNotAdmitted,
    leaseLapsed,
    lapsedNotReclaimed,
    cancelOverdue,
    deadlineNotCancelled,
    corrupt: inOrder(corrupt),
  }
}

async function queueStatus(dialect: OperatorReadsDialect, queue: string): Promise<QueueStatus> {
  const { counted } = dialect
  const limit = OPERATOR_GAUGE_CAP + 1
  const b = dialect.open.queueStatus()
  const runs = (rows: SqlFragment, instant: RunInstant) => runInstantsRead({ limit, rows, instant })
  b.readTree('pending', runs(counted.pendingRuns(queue), 'available_at_ms'))
  b.readTree('sleeping', runs(counted.sleepingRuns(queue), 'available_at_ms'))
  b.readTree('running', runs(counted.runningRuns(queue), 'claim_expires_at_ms'))
  const deadlineLegs = counted.tasksWithADeadline(queue).map((rows, leg) => {
    b.readTree(`deadlines-${leg}`, taskDeadlinesRead({ limit, rows }))
    return `deadlines-${leg}`
  })
  // No leg reads the clock, so this is the batch's one read of it.
  b.readTree('now', databaseNowRead({}))
  const liveLegs = liveTaskLegs(b, counted.liveTasks(queue), limit, liveTaskInstantsRead)
  const ran = await dialect.run(b)
  const fakeClock = flagOf('fake-clock', await dialect.fakeClock())

  const corrupt: CorruptInteger[] = []
  const nowMs = reportTime(b, ran, corrupt)
  /** The instant of every row of one leg, null where the stored one is not readable. */
  const instantsOf = (leg: string, key: 'run_id' | 'task_id', bounds: PersistedIntegerBounds) =>
    readRows(b, ran, leg).map((row) => {
      const id = stringFrom(row[key])
      return integersOf(row, corrupt, key === 'run_id' ? { runId: id } : { taskId: id })(bounds)
    })
  const pending = instantsOf('pending', 'run_id', RUN.available_at_ms)
  const sleeping = instantsOf('sleeping', 'run_id', RUN.available_at_ms)
  const running = instantsOf('running', 'run_id', RUN.claim_expires_at_ms)
  const deadlines = deadlineLegs.flatMap((leg) => instantsOf(leg, 'task_id', TASK.cancel_at_ms))
  const enqueued = liveLegs.flatMap((leg) => instantsOf(leg, 'task_id', TASK.enqueue_at_ms))

  const readable = (instants: readonly (number | null)[]): number[] =>
    instants.filter((at): at is number => at !== null)
  /** The instants of a leg that are at or before database time. */
  const cameDue = (instants: readonly (number | null)[]): number[] =>
    nowMs === null ? [] : readable(instants).filter((at) => at <= nowMs)
  const earliest = (instants: readonly number[]): number | null =>
    instants.length === 0 ? null : Math.min(...instants)
  const gauge = (rows: readonly unknown[]): Gauge => gaugeOf(rows.length, OPERATOR_GAUGE_CAP)

  const headOfTheQueue = earliest([...cameDue(pending), ...cameDue(sleeping)])
  const firstExpiry = earliest(readable(running))
  const firstEnqueued = earliest(readable(enqueued))
  return {
    nowMs,
    fakeClock,
    gauges: {
      pendingRuns: gauge(pending),
      pendingRunsDue: gauge(cameDue(pending)),
      sleepingRuns: gauge(sleeping),
      sleepingRunsDue: gauge(cameDue(sleeping)),
      runningRuns: gauge(running),
      runningRunsLapsed: gauge(cameDue(running)),
      tasksWithADeadline: gauge(deadlines),
      tasksPastTheirDeadline: gauge(cameDue(deadlines)),
      liveTasks: gauge(enqueued),
    },
    claimLagMs: nowMs === null || headOfTheQueue === null ? null : nowMs - headOfTheQueue,
    leaseHeadroomMs: nowMs === null || firstExpiry === null ? null : firstExpiry - nowMs,
    nextWakeAtMs: earliest(readable([...pending, ...sleeping, ...running, ...deadlines])),
    oldestLiveTaskAgeMs: nowMs === null || firstEnqueued === null ? null : nowMs - firstEnqueued,
    corrupt: inOrder(corrupt),
  }
}

/** One row past the cap is the most a count of `table-rows` may answer. */
const COUNTED_ROWS = freeze({ min: 0, max: OPERATOR_TABLE_ROWS_CAP + 1 })

async function tableRows(dialect: OperatorReadsDialect, queue: string): Promise<TableRows> {
  const b = dialect.open.tableRows()
  for (const table of QUEUE_TABLES) {
    b.readTree(table, tableRowsRead({ table, queue, cap: OPERATOR_TABLE_ROWS_CAP }))
  }
  const ran = await dialect.run(b)
  const tables = createObject(null) as Record<QueueTable, Gauge>
  for (const table of QUEUE_TABLES) {
    // A count is the statement's own answer, never a stored value: a dialect that hands it
    // back as anything but an integer in the statement's range is refused.
    const counted = decodeBoundedInteger(readRows(b, ran, table)[0]?.row_count, COUNTED_ROWS)
    if (!counted.ok) {
      throw new TrustedRangeError(
        `table-rows ${table} must count an integer from 0 to ${COUNTED_ROWS.max}`,
      )
    }
    tables[table] = gaugeOf(counted.value, OPERATOR_TABLE_ROWS_CAP)
  }
  return { cap: OPERATOR_TABLE_ROWS_CAP, tables: freeze(tables) }
}

async function eventWaiters(
  dialect: OperatorReadsDialect,
  queue: string,
  eventName: string,
): Promise<EventWaiters> {
  const b = dialect.open.eventWaiters()
  b.readTree('waiters', eventWaitersRead({ queue, eventName, limit: OPERATOR_GAUGE_CAP + 1 }))
  const corrupt: CorruptInteger[] = []
  // The statement answers the waits in the order of run and then step, one row past the
  // cap, and the list keeps that order. Nothing here sorts them: a list cut in one order
  // and printed in another leaves out a wait that comes before one it lists.
  const read = readRows(b, await dialect.run(b), 'waiters').map((row): EventWaiter => {
    const runId = stringFrom(row.run_id)
    const stepName = stringFrom(row.step_name)
    const timesOutAt = integersOf(row, corrupt, { runId, stepName })(WAIT.timeout_at_ms)
    return { taskId: stringFrom(row.task_id), runId, stepName, timeoutAtMs: timesOutAt }
  })
  return {
    waiters: {
      rows: read.slice(0, OPERATOR_GAUGE_CAP),
      atLeast: read.length > OPERATOR_GAUGE_CAP,
    },
    corrupt: inOrder(corrupt),
  }
}

async function eventPayload(
  dialect: OperatorReadsDialect,
  queue: string,
  eventName: string,
): Promise<StoredEventPayload> {
  const b = dialect.open.eventPayload()
  b.readTree(
    'event',
    eventPayloadRead({ queue, eventName, payloadType: dialect.storedPayloadType }),
  )
  const row = readRows(b, await dialect.run(b), 'event')[0]
  if (row === undefined) return { exists: false }
  const stored = row.payload
  const type = textOf(row.payload_type)
  if (type === 'text' && typeof stored === 'string') return { exists: true, payloadJson: stored }
  // An event's payload is text on every engine path. A stored value of another kind is
  // never read as a payload. It is named by the dialect's own name for its type, or, where
  // the dialect calls it text and hands back something else, by the kind of what it handed.
  return {
    exists: true,
    payloadJson: null,
    stored: type === null || type === 'text' ? storageValueKind(stored) : type,
  }
}

/**
 * Why the statements of `task-admission` may see different clocks, the reason `readTree`
 * asks of every read of the clock after a batch's first. Each flag is one of the engine's
 * predicates at the instant of its own statement, and each is answered beside the state
 * and the instant of the row it was read from. The answer's time is read by the batch's
 * last statement, so no flag saw a later clock than the one the answer is dated by.
 */
const ADMISSION_DRIFT =
  "read-only report: each flag holds one of the engine's predicates at the instant of its own statement, beside the state and the instant of the row it read, and the last statement reads the time the answer is dated by"

async function taskAdmission(
  dialect: OperatorReadsDialect,
  queue: string,
  taskId: string,
): Promise<TaskAdmission | null> {
  const { owed, taskOwnsRun } = dialect
  const b = dialect.open.taskAdmission()
  b.readTree('retry', taskAdmissionRetryRead({ queue, taskId, conjuncts: dialect.retryConjuncts }))
  b.readTree('sweep', taskAdmissionSweepRead({ queue, taskId, dueCancels: owed.dueCancels(queue) }))
  b.readTree(
    'runs',
    taskAdmissionRunsRead({
      taskId,
      taskOwnsRun,
      pendingRuns: owed.pendingRuns(queue),
      sleepingRuns: owed.sleepingRuns(queue),
      expiredClaims: owed.expiredClaims(queue),
    }),
    ADMISSION_DRIFT,
  )
  b.readTree('now', databaseNowRead({}), ADMISSION_DRIFT)
  const ran = await dialect.run(b)
  const guard = readRows(b, ran, 'retry')[0]
  const task = readRows(b, ran, 'sweep')[0]
  // One snapshot answers both reads of the task, so it is in both or in neither.
  if (guard === undefined || task === undefined) return null
  const corrupt: CorruptInteger[] = []
  const retry = createObject(null) as Record<RetryGuardConjunct, boolean | 'not-asked'>
  for (const name of RETRY_GUARD) {
    const what = `task-admission ${name}`
    retry[name] =
      RETRY_CONJUNCT_COMPUTES_WITH[name] !== undefined
        ? askedFlag(what, guard[name])
        : flagOf(what, guard[name])
  }
  const runs = readRows(b, ran, 'runs').map((row): RunAdmission => {
    const runId = stringFrom(row.run_id)
    const int = integersOf(row, corrupt, { runId })
    const claims = int(RUN.claim_gen)
    const availableAt = int(RUN.available_at_ms)
    const leaseEndsAt = int(RUN.claim_expires_at_ms)
    return {
      runId,
      state: stringFrom(row.state),
      claimGen: claims,
      availableAtMs: availableAt,
      claimExpiresAtMs: leaseEndsAt,
      // A claim takes a run of either state it may take, by that state's own predicate.
      claimTakes:
        flagOf('task-admission claimTakesPending', row.claimTakesPending) ||
        flagOf('task-admission claimTakesSleeping', row.claimTakesSleeping),
      sweepReclaims: flagOf('task-admission sweepReclaims', row.sweepReclaims),
    }
  })
  // By id. The read hands no ordinal over: one at the edge of its column is no number.
  runs.sort((left, right) => byCodePoints(left.runId, right.runId))
  return {
    nowMs: reportTime(b, ran, corrupt),
    state: stringFrom(task.state),
    cancelAtMs: integersOf(task, corrupt, { taskId })(TASK.cancel_at_ms),
    retry: freeze(retry),
    sweepCancels: flagOf('task-admission sweepCancels', task.sweepCancels),
    runs,
    corrupt: inOrder(corrupt),
  }
}

/**
 * The operator's read port over one dialect, and the only implementation of it. Every
 * method the string table names is reached through `requireOperatorReadStrings`, put in
 * front of it here in one loop, so no method can leave the check out, and a method the
 * port gains is checked once the table names its strings, which the table's type makes it
 * do. A refusal is a rejected promise, as a store's is.
 */
export function createOperatorReads(dialect: OperatorReadsDialect): HeldOperatorReads {
  const entries: OperatorReads = {
    taskFacts: (queue, taskId) => taskFacts(dialect, queue, taskId),
    taskIdByKey: (queue, idempotencyKey) => taskIdByKey(dialect, queue, idempotencyKey),
    eventState: (queue, eventName) => eventState(dialect, queue, eventName),
    stuckRuns: (queue, options) => stuckRuns(dialect, queue, options),
    agedTasks: (queue, options) => agedTasks(dialect, queue, options),
    queueStatus: (queue) => queueStatus(dialect, queue),
    tableRows: (queue) => tableRows(dialect, queue),
    eventWaiters: (queue, eventName) => eventWaiters(dialect, queue, eventName),
    eventPayload: (queue, eventName) => eventPayload(dialect, queue, eventName),
    taskAdmission: (queue, taskId) => taskAdmission(dialect, queue, taskId),
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
  return freeze(held) as HeldOperatorReads
}

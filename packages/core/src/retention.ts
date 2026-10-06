import { spawningParent } from './child-tasks.js'
import { MIN_RETENTION_SECONDS } from './contract.js'
import { PortRefusalError } from './errors.js'
import { type FencedBatch, type FencedResult, readRows } from './fenced-batch.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import { byCodePoints, requireListLimit } from './operator-reads.js'
import { RETENTION_METHODS, type RetentionMethod, requireRetentionStrings } from './port-strings.js'
import type { Retention } from './ports.js'
import type { SqlRow } from './primitives.js'
import type { SqlFragment } from './sql-tree.js'
import {
  type PurgeUnitBinds,
  type RetentionWindows,
  purgeCandidatesRead,
  purgeUnitCas,
  purgedTaskDelete,
  purgedUnitRowsRead,
} from './statements/purge.js'
import { QUEUE_TABLES, type QueueTable } from './store-tables.js'
import {
  type PurgeCandidate,
  type PurgeCandidates,
  type PurgeCandidatesOptions,
  type PurgeCursor,
  type PurgeUnitTarget,
  type PurgedUnit,
  type RetentionPolicy,
  TERMINAL_STATES,
  type TerminalState,
} from './types.js'
import {
  MAX_DURATION_MS,
  MAX_EPOCH_MS,
  PERSISTED_INTEGER_BOUNDS,
  decodeBoundedInteger,
} from './validate.js'

const {
  ArrayIsArray: isArray,
  NumberIsSafeInteger: isSafeInteger,
  ObjectCreate: createObject,
  ObjectFreeze: freeze,
  ObjectKeys: objectKeys,
  PromiseReject: rejected,
  ReflectApply: apply,
  ReflectGet: reflectGet,
  StringFrom: stringFrom,
  TypeError: TrustedTypeError,
} = TASK_INTRINSICS

/**
 * What a dialect supplies to retention (DESIGN.md §3.12). Each member is a fact of the
 * dialect: its two batches and how it runs one, which ended tasks its index of them hands
 * out, and how it proves a stored stamp. The policy's check, the barrier, the statements
 * of the purge and their order, the check of every delete's row count, and the check of
 * every string are core's, so a dialect inherits them: what `createRetention` returns is
 * the only value of the held type, which is the type a store's factory hands out.
 *
 * A dialect opens each batch itself and runs it itself, as it does for `TaskDoneDialect`,
 * so every batch label stays a literal at a construction site in a store, and every batch
 * reaches the executor from a store: that is where the label ledger, the batch lint and
 * the fault matrix read them.
 */
export interface RetentionDialect {
  /** Run a batch this dialect opened against its executor. */
  run(batch: FencedBatch): Promise<FencedResult>
  readonly open: {
    /** `purge-candidates`, a batch of reads. */
    purgeCandidates(): FencedBatch
    /** `purge-unit`, a transition under a seed no other invocation uses. */
    purgeUnit(): FencedBatch
  }
  /**
   * Over a task `t`: it is in this queue, it ended in `state`, and it holds a stamp instant
   * in range. The predicate binds the queue once, and it is written so that the dialect's
   * index of ended tasks hands the rows out in the order of their stamps.
   */
  endedTasks(state: TerminalState, queue: string): SqlFragment
  /** The row `tasks` holds a stamp instant in range. It binds nothing. */
  readonly stampStored: SqlFragment
}

declare const heldRetention: unique symbol

/**
 * The retention port with the check of every string in front of every method. The type is
 * nominal and `createRetention` alone makes a value of it, so an object that implements
 * `Retention` on its own does not type as one. A store's factory hands this out.
 */
export type HeldRetention = Retention & { readonly [heldRetention]: true }

/** The longest window a policy may name, in seconds: the longest duration the engine takes. */
const MAX_RETENTION_SECONDS = MAX_DURATION_MS / 1000

/** The window of each ended state, by the member of the policy that names it. */
const WINDOW_OF = freeze({
  completed: 'completedSeconds',
  failed: 'failedSeconds',
  cancelled: 'cancelledSeconds',
} as const satisfies Record<TerminalState, keyof RetentionPolicy>)

/**
 * A policy's windows in milliseconds, or a refusal (DESIGN.md §3.12). Every window is a
 * whole number of seconds, at least `MIN_RETENTION_SECONDS`. The completed and the
 * cancelled window are required: there is no default policy. The failed window may be
 * left out, and failed tasks are then kept. Each member is read once, and anything that
 * is not such a number is refused, a window that was passed as null or as text included:
 * a policy that could be misread would purge what its caller meant to keep.
 */
export function retentionWindowsMs(policy: RetentionPolicy): RetentionWindows {
  if (typeof policy !== 'object' || policy === null) {
    throw new PortRefusalError(
      'a retention policy must be an object that names completedSeconds and cancelledSeconds',
    )
  }
  const windowOf = (state: TerminalState): number | null => {
    const member = WINDOW_OF[state]
    const seconds: unknown = reflectGet(policy, member)
    if (seconds === undefined && member === 'failedSeconds') return null
    if (
      typeof seconds !== 'number' ||
      !isSafeInteger(seconds) ||
      seconds < MIN_RETENTION_SECONDS ||
      seconds > MAX_RETENTION_SECONDS
    ) {
      throw new PortRefusalError(
        `retention policy ${member} must be a whole number of seconds from ${MIN_RETENTION_SECONDS} to ${MAX_RETENTION_SECONDS}, got ${stringFrom(seconds)}`,
      )
    }
    return seconds * 1000
  }
  // The one place a policy's windows are made: every window above was held to the floor.
  return freeze({
    completed: windowOf('completed'),
    failed: windowOf('failed'),
    cancelled: windowOf('cancelled'),
  }) as RetentionWindows
}

/**
 * Why the legs of `purge-candidates` may see different clocks, the reason `readTree` asks
 * of each leg after the first. A task on the edge of its window can be in one page and not
 * the one a moment earlier would have been, and nothing is decided from a page.
 */
const PURGE_CANDIDATES_DRIFT =
  'read-only listing: a candidate is only a candidate, and the purge of each reads the clock again inside its own compare-and-set'

const STAMP = PERSISTED_INTEGER_BOUNDS.tasks.fence_at_ms

/** Where a listing starts when no cursor is given: before every stamp and every task id. */
const FROM_THE_OLDEST: PurgeCursor = freeze({ endedAtMs: -1, taskId: '' })

/** The place a page starts after. The port's check of strings has held the task id. */
function startAfter(after: PurgeCursor | undefined): PurgeCursor {
  if (after === undefined) return FROM_THE_OLDEST
  const endedAtMs: unknown = reflectGet(after, 'endedAtMs')
  if (
    typeof endedAtMs !== 'number' ||
    !isSafeInteger(endedAtMs) ||
    endedAtMs < 0 ||
    endedAtMs > MAX_EPOCH_MS
  ) {
    throw new PortRefusalError(
      `purgeCandidates after.endedAtMs must be an integer epoch-ms in [0, ${MAX_EPOCH_MS}], got ${stringFrom(endedAtMs)}`,
    )
  }
  return { endedAtMs, taskId: after.taskId }
}

/**
 * One row of a leg as a candidate. A leg answers only a task of its own state whose stamp
 * its store held to the range, so any other row is a defect of the dialect, and no
 * candidate is built from one.
 */
function candidateOf(state: TerminalState, row: SqlRow): PurgeCandidate {
  const endedAt = decodeBoundedInteger(row.fence_at_ms, STAMP)
  const { task_id: taskId, task_name: taskName, idempotency_key: key } = row
  if (
    !endedAt.ok ||
    row.state !== state ||
    typeof taskId !== 'string' ||
    typeof taskName !== 'string' ||
    (key !== null && typeof key !== 'string')
  ) {
    throw new TrustedTypeError(
      `purge-candidates answered a row that is no ${state} task with a stamp in range`,
    )
  }
  const candidate = { taskId, taskName, state, endedAtMs: endedAt.value }
  return freeze(key === null ? candidate : { ...candidate, idempotencyKey: key })
}

async function purgeCandidates(
  dialect: RetentionDialect,
  queue: string,
  policy: RetentionPolicy,
  options: PurgeCandidatesOptions,
): Promise<PurgeCandidates> {
  const windowsMs = retentionWindowsMs(policy)
  if (typeof options !== 'object' || options === null) {
    throw new PortRefusalError('purgeCandidates options must be an object that names a limit')
  }
  const limit = requireListLimit(options.limit)
  const after = startAfter(options.after)
  const b = dialect.open.purgeCandidates()
  // One leg to an ended state, each read one row past the limit, so the oldest of them all
  // are among the rows read, and the page says whether anything follows it. A state the
  // policy keeps lists nothing, and its leg is sent with a limit of no rows: the batch
  // keeps its one shape, and the leg reads none of that state's tasks to find that none is
  // old enough.
  const legs = TERMINAL_STATES.map((state, leg) => {
    const name = `ended-${state}`
    b.readTree(
      name,
      purgeCandidatesRead({
        limit: windowsMs[state] === null ? 0 : limit + 1,
        ended: dialect.endedTasks(state, queue),
        windowMs: windowsMs[state],
        after,
      }),
      leg === 0 ? '' : PURGE_CANDIDATES_DRIFT,
    )
    return { name, state }
  })
  const ran = await dialect.run(b)
  const listed = legs.flatMap(({ name, state }) =>
    readRows(b, ran, name).map((row) => candidateOf(state, row)),
  )
  // The order every leg was read in: the instant a task ended, and then its id.
  listed.sort(
    (left, right) => left.endedAtMs - right.endedAtMs || byCodePoints(left.taskId, right.taskId),
  )
  const candidates = listed.slice(0, limit)
  const last = candidates[candidates.length - 1]
  return freeze({
    candidates: freeze(candidates),
    next:
      listed.length > limit && last !== undefined
        ? freeze({ endedAtMs: last.endedAtMs, taskId: last.taskId })
        : null,
  })
}

/**
 * The purge of one unit, as the statements of its batch (DESIGN.md §3.12). The
 * compare-and-set stamps the task row the barrier admits. The unit is then read, and
 * deleted by statements keyed on that stamp: the checkpoints, the waits through the runs
 * they name, the runs, the completion event, and the task row last, because every other
 * delete finds its rows through it. The runs are stamped before their waits go, because
 * a wait is reached through the run it names and a generated delete follows a stamp.
 */
export function addUnitPurge(b: FencedBatch, binds: PurgeUnitBinds): void {
  const { queue, taskId } = binds
  const ofTheUnit = { where: 'f.task_id = ?', whereArgs: [taskId] }
  b.casTree('purge', purgeUnitCas(binds))
  b.tailTree('unit', purgedUnitRowsRead({ queue, taskId }))
  b.derived('checkpoints', {
    relation: 'tasks-to-checkpoints',
    fence: 'purge',
    ...ofTheUnit,
    rows: 'source-keys',
  })
  b.derived('runs', {
    relation: 'tasks-to-runs',
    fence: 'purge',
    queue,
    ...ofTheUnit,
    // Every run of an ended task has given its claim up, so this assigns what is there.
    // The statement is here for the stamp it writes, which the delete of the waits follows.
    set: { claimed_by: 'NULL' },
    // The runs are named on the written side too, by the task's id, so that a store reaches
    // them through the index of a task's runs and not through the runs of its queue.
    narrow: 'task_id = ?',
    narrowArgs: [taskId],
    rows: 'source-keys',
  })
  b.derived('waits', {
    relation: 'runs-to-waits',
    fence: 'runs',
    ...ofTheUnit,
    rows: 'source-keys',
  })
  b.derived('runs-gone', {
    relation: 'tasks-to-runs',
    fence: 'purge',
    queue,
    ...ofTheUnit,
    rows: 'source-keys',
  })
  b.derived('event', { relation: 'tasks-to-events', fence: 'purge', ...ofTheUnit, rows: 'one' })
  b.followOnTree('task', purgedTaskDelete({ queue, taskId }), 'one')
}

/** The statement of the purge batch that deletes from each table of a unit. */
const DELETES = freeze({
  checkpoints: 'checkpoints',
  waits: 'waits',
  runs: 'runs-gone',
  events: 'event',
  tasks: 'task',
} as const satisfies Record<QueueTable, string>)

const UNIT_ROWS = freeze({ min: 0, max: Number.MAX_SAFE_INTEGER })

/**
 * What a purge that won deleted, each table's count held to what the unit held when the
 * compare-and-set admitted it. The batch has committed by now, so a count that differs
 * cannot be undone: it is thrown, because a purge that deleted anything but the unit it
 * read is a defect that no caller should take for a purge.
 */
function purgedRows(b: FencedBatch, ran: FencedResult, taskId: string): PurgedUnit {
  const unit = readRows(b, ran, 'unit')[0]
  if (unit === undefined) {
    throw new TrustedTypeError(`purgeUnit ${taskId}: the purge won and its batch read no unit`)
  }
  const rows = createObject(null) as Record<QueueTable, number>
  for (const table of QUEUE_TABLES) {
    // The task row is the one the compare-and-set stamped, so a unit holds exactly one.
    const held =
      table === 'tasks' ? { ok: true, value: 1 } : decodeBoundedInteger(unit[table], UNIT_ROWS)
    if (!held.ok) {
      throw new TrustedTypeError(
        `purgeUnit ${taskId}: the batch read no count of the unit's ${table}`,
      )
    }
    const deleted = ran.results[DELETES[table]]?.rowsAffected
    if (deleted !== held.value) {
      throw new Error(
        `purgeUnit ${taskId}: the batch deleted ${stringFrom(deleted)} rows of ${table}, and the unit its compare-and-set read held ${held.value}`,
      )
    }
    rows[table] = held.value
  }
  return freeze({ taskId, rows: freeze(rows) })
}

async function purgeUnit(
  dialect: RetentionDialect,
  queue: string,
  unit: PurgeUnitTarget,
  policy: RetentionPolicy,
): Promise<PurgedUnit | null> {
  const windowsMs = retentionWindowsMs(policy)
  const taskId = unit.taskId
  const idempotencyKey = unit.idempotencyKey ?? null
  // A key in the engine's spawn namespace that names no parent: it is not known whose
  // child the task is, so nothing says its parent can no longer run, and the unit is kept.
  // The builder of the purge would refuse the key too. The port answers as for any unit
  // the barrier keeps.
  if (!spawningParent(idempotencyKey).known) return null
  const b = dialect.open.purgeUnit()
  addUnitPurge(b, {
    queue,
    taskId,
    idempotencyKey,
    windowsMs,
    stampStored: dialect.stampStored,
  })
  const ran = await dialect.run(b)
  return ran.won === 'purge' ? purgedRows(b, ran, taskId) : null
}

/**
 * The retention port over one dialect, and the only implementation of it. Every method
 * the string table names is reached through `requireRetentionStrings`, put in front of it
 * here in one loop, as `createOperatorReads` does for the operator's reads. A refusal is a
 * rejected promise, as a store's is.
 */
/** How deep an argument of the port holds objects: the options, and the cursor they hold. */
const ARGUMENT_DEPTH = 2

/**
 * One reading of an argument. An object is read member by member, each of its own
 * members once, into a frozen object that holds what was read, and an object a member
 * holds is read the same way. Everything behind the port then reads that copy: the check
 * of strings, and the method. So what the check read is what a batch binds, for every
 * member an argument has or gains, and a member that would answer its second reader
 * another value has no second reader. A member an argument only inherits is not read:
 * the port takes plain objects, and such a member is as one left out.
 */
function readOnce(value: unknown, depth: number): unknown {
  if (depth === 0 || typeof value !== 'object' || value === null || isArray(value)) return value
  const read = createObject(null) as Record<string, unknown>
  const members = objectKeys(value)
  for (let index = 0; index < members.length; index++) {
    const member = members[index]
    if (member === undefined) continue
    read[member] = readOnce(reflectGet(value, member), depth - 1)
  }
  return freeze(read)
}

export function createRetention(dialect: RetentionDialect): HeldRetention {
  const entries: Retention = {
    purgeCandidates: (queue, policy, options) => purgeCandidates(dialect, queue, policy, options),
    purgeUnit: (queue, unit, policy) => purgeUnit(dialect, queue, unit, policy),
  }
  const held: Partial<Record<RetentionMethod, unknown>> = {}
  for (let index = 0; index < RETENTION_METHODS.length; index++) {
    const method = RETENTION_METHODS[index]
    if (method === undefined) continue
    const entry: (...args: never[]) => Promise<unknown> = entries[method]
    held[method] = (...args: unknown[]): Promise<unknown> => {
      const once: unknown[] = []
      try {
        for (let at = 0; at < args.length; at++) once[at] = readOnce(args[at], ARGUMENT_DEPTH)
        requireRetentionStrings(method, once)
      } catch (error) {
        return rejected(error)
      }
      return apply(entry, undefined, once)
    }
  }
  return freeze(held) as HeldRetention
}

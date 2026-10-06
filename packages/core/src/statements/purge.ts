import { type Expression, type ExpressionBuilder, type SqlBool, expressionBuilder } from 'kysely'
import { EventName, spawningParent, taskDoneEventName } from '../child-tasks.js'
import { MAX_PURGE_UNIT_CHECKPOINTS } from '../contract.js'
import {
  type DefinedStatement,
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  literalValue,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { LIVE_STATES, type PurgeCursor, TERMINAL_STATES, type TerminalState } from '../types.js'
import { markUnitPurge } from '../unit-purge.js'
import { whereTaskInQueue } from './claimed-run.js'

/**
 * The statements of retention (DESIGN.md §3.12, specs/Retention.tla): the read of what a
 * purge may take, and the batch that purges one ended task's unit. They are built from
 * nodes but for two facts a dialect supplies as text: which ended tasks its index of them
 * hands out, and that a stored stamp is an instant in range.
 */

declare const policyWindows: unique symbol

/**
 * A retention policy as the statements take it: for each ended state, its window in
 * milliseconds, or null for a state the policy keeps. A null window is bound like any
 * other, so a statement's text does not depend on what the policy names. Database time
 * less no window is no instant, and no stamp is at or before that, so a state with no
 * window is never old enough.
 *
 * The type is nominal. `retentionWindowsMs` alone makes a value of it, after it has held
 * every window to the floor, so nothing else in core hands a statement a window of its own
 * choosing without a cast that says so.
 */
export type RetentionWindows = Readonly<Record<TerminalState, number | null>> & {
  readonly [policyWindows]: true
}

/**
 * The window comparison, the one definition of it: an instant is at least a window behind
 * database time. The read of candidates and the purge's compare-and-set both hold a
 * stamp to it, so the two cannot disagree about when a task is old enough.
 */
const atLeastAWindowOld = (
  stampedAt: Expression<number | bigint | null>,
  windowMs: number | null,
): Expression<SqlBool> => {
  const eb = expressionBuilder<StoreTables, never>()
  return eb(stampedAt, '<=', eb(nowValue, '-', eb.val(windowMs) as Expression<number>))
}

/**
 * One leg of `purge-candidates`: the ended tasks of one state that are at least that
 * state's window old, oldest first, after the place a page before ended, up to a limit.
 * `ended` is the store's predicate over a task `t`: its queue, that state, and a stamp
 * stored in range, written so that the index of ended tasks hands the rows out in the
 * order of their stamps. The order is the stamp and then the task's id, which every
 * dialect compares by its bytes, so a page ends at a place the next one can start after.
 */
export const purgeCandidatesRead = defineStatement(
  'purge-candidates',
  (binds: {
    limit: number
    ended: SqlFragment
    /** The state's window, or null for a state the policy keeps, which lists nothing. */
    windowMs: number | null
    /** Where the page before this one ended. Before every stamp, for the first page. */
    after: PurgeCursor
  }) =>
    treeBuilder
      .selectFrom('tasks as t')
      .select(['t.task_id', 't.task_name', 't.state', 't.fence_at_ms', 't.idempotency_key'])
      .where(rawSql<boolean>(binds.ended, 'predicate'))
      .where((eb) => atLeastAWindowOld(eb.ref('t.fence_at_ms'), binds.windowMs))
      .where('t.fence_at_ms', '>=', binds.after.endedAtMs)
      .where((eb) =>
        eb.or([
          eb('t.fence_at_ms', '>', binds.after.endedAtMs),
          eb('t.task_id', '>', binds.after.taskId),
        ]),
      )
      .orderBy('t.fence_at_ms')
      .orderBy('t.task_id')
      .limit(binds.limit),
)

/** What the purge of one unit is given. */
export type PurgeUnitBinds = {
  readonly queue: string
  readonly taskId: string
  /**
   * The idempotency key the unit's task was spawned under, as its caller read it, or null.
   * The task that spawned the unit is read from this key by the builder itself, so a
   * caller names no parent.
   */
  readonly idempotencyKey: string | null
  readonly windowsMs: RetentionWindows
  /** The store's proof that the row `tasks` holds a stamp instant in range. It binds nothing. */
  readonly stampStored: SqlFragment
}

/** A unit with the task that spawned it, which its key names, or null for a task no task spawned. */
type UnitUnderItsParent = PurgeUnitBinds & { readonly parentTaskId: string | null }

type TaskRow = ExpressionBuilder<StoreTables, 'tasks'>
type Barrier = (task: TaskRow, binds: UnitUnderItsParent) => Expression<SqlBool>

/**
 * The barrier (DESIGN.md §3.12): what the purge's compare-and-set requires of the task row
 * it stamps, each condition under a name, in the order the statement holds them. Every one
 * is read inside that statement, at the instant of deletion. B1 to B5 are the model's
 * (specs/Retention.tla). The last three are the statement's own: they hold the unit to
 * what the batch then deletes.
 */
const PURGE_BARRIER = {
  // B1: the task ended in a state the policy names, at least that state's window ago.
  endedAWindowAgo: (task, binds) =>
    task.or(
      TERMINAL_STATES.map((state) =>
        task.and([
          task('state', '=', literalValue(state)),
          atLeastAWindowOld(task.ref('fence_at_ms'), binds.windowsMs[state]),
        ]),
      ),
    ),
  // B1: and the stamp that age is read from is a stored instant in range.
  stampInRange: (_task, binds) => rawSql<boolean>(binds.stampStored, 'predicate'),
  // B2: no run of the task is live. Tasks mirror their runs, so this is a defence.
  noLiveRun: (task, binds) =>
    task.not(
      task.exists(
        task
          .selectFrom('runs as live')
          .select('live.run_id')
          .where('live.task_id', '=', binds.taskId)
          .where('live.state', 'in', [...LIVE_STATES]),
      ),
    ),
  // B3: no run of another unit in this queue, in any state, holds the task's outcome: a
  // wake that names the completion event and carries a payload. The first two tests are
  // the terms of the index of such runs, written as that index writes them.
  noRunHoldsTheOutcome: (task, binds) =>
    task.not(
      task.exists(
        task
          .selectFrom('runs as holder')
          .select('holder.run_id')
          .where('holder.queue', '=', binds.queue)
          .where('holder.wake_event', 'is not', null)
          .where('holder.event_payload', 'is not', null)
          .where('holder.wake_event', '=', taskDoneEventName(binds.taskId))
          .where('holder.task_id', '<>', binds.taskId),
      ),
    ),
  // B4: no wait names the completion event.
  noWaitOnTheOutcome: (task, binds) =>
    task.not(
      task.exists(
        task
          .selectFrom('waits as waiter')
          .select('waiter.run_id')
          .where('waiter.queue', '=', binds.queue)
          .where('waiter.event_name', '=', taskDoneEventName(binds.taskId)),
      ),
    ),
  // B5: the spawning parent is absent, completed, or cancelled, which is to say that no
  // task with its id is live or failed. It is looked up by its id alone, in every queue.
  // The parent's row is read through a derived table of one row, because one dialect
  // refuses a statement that reads the table it writes any other way. A task no task
  // spawned names no parent: the id bound is NULL, which equals no task's.
  parentCannotRunAgain: (task, binds) =>
    task.not(
      task.exists(
        task
          .selectFrom(
            task
              .selectFrom('tasks as p')
              .select('p.state')
              .distinct()
              .where('p.task_id', '=', task.val(binds.parentTaskId) as Expression<string>)
              .as('parent'),
          )
          .select('parent.state')
          .where((parent) =>
            parent.or([
              parent('parent.state', 'in', [...LIVE_STATES]),
              parent('parent.state', '=', literalValue('failed')),
            ]),
          ),
      ),
    ),
  // The key is the one the caller read the parent from, so the parent B5 looked up is the
  // one this row names.
  spawnedUnderThisKey: (task, binds) =>
    task(
      'idempotency_key',
      'is not distinct from',
      task.val(binds.idempotencyKey) as Expression<string>,
    ),
  // Every run of the task is in the task's queue, where the batch deletes them.
  ownsEveryRun: (task, binds) =>
    task.not(
      task.exists(
        task
          .selectFrom('runs as stray')
          .select('stray.run_id')
          .where('stray.task_id', '=', binds.taskId)
          .where('stray.queue', '<>', binds.queue),
      ),
    ),
  // The unit holds no more checkpoints than one batch may delete. The count stops one row
  // past the cap, so a unit far past it costs no more to refuse.
  withinTheCheckpointCap: (task, binds) =>
    task(
      task
        .selectFrom(
          task
            .selectFrom('checkpoints as c')
            .select('c.task_id')
            .where('c.task_id', '=', binds.taskId)
            .limit(MAX_PURGE_UNIT_CHECKPOINTS + 1)
            .as('counted'),
        )
        .select((counted) => counted.fn.countAll<number>().as('held'))
        .$asScalar(),
      '<=',
      MAX_PURGE_UNIT_CHECKPOINTS,
    ),
} satisfies Readonly<Record<string, Barrier>>

const purgeCas = defineStatement(
  'purge-unit',
  (binds: UnitUnderItsParent) =>
    treeBuilder
      .updateTable('tasks')
      .set({ ...FENCE_ASSIGNMENTS })
      .$call(whereTaskInQueue(binds))
      .where((task) =>
        task.and(Object.values(PURGE_BARRIER).map((holds: Barrier) => holds(task, binds))),
      ),
  // The lock of the completion event the batch deletes: the purge is serialized against
  // every await, emit, and terminal batch of that event (§3.4 rule 2).
  (binds) => ({ queue: binds.queue, eventName: EventName.taskDone(binds.taskId) }),
)

/**
 * `purge-unit`'s compare-and-set: stamp the task row of a unit the barrier admits, and
 * change nothing else of it. The stamp is what every delete of the batch is keyed on. The
 * statement is marked as the purge of a unit, and a batch deletes a row of a task's unit
 * only under the stamp of a statement so marked.
 *
 * The parent B5 asks about is read here, from the unit's key, and from nowhere else: a
 * caller cannot name another. A key in the engine's namespace that names no parent builds
 * nothing, because nothing says that the unit's parent can no longer run.
 */
export const purgeUnitCas = (binds: PurgeUnitBinds): DefinedStatement => {
  const parent = spawningParent(binds.idempotencyKey)
  if (!parent.known) {
    throw new TypeError(
      "purge-unit: the unit's key is in the engine's namespace and names no parent, so no purge is built",
    )
  }
  return markUnitPurge(purgeCas({ ...binds, parentTaskId: parent.taskId }))
}

/**
 * `purge-unit`'s read of the unit its compare-and-set stamped: how many runs, checkpoints,
 * and waits the unit holds, and whether its completion event exists. It stands straight
 * after the compare-and-set and before every delete, so each delete's row count is held to
 * what the unit held when the barrier admitted it.
 */
export const purgedUnitRowsRead = defineStatement(
  'purge-unit rows',
  (binds: { queue: string; taskId: string }) =>
    treeBuilder
      .selectFrom('tasks as f')
      .select((eb) => [
        eb
          .selectFrom('runs as r')
          .select((count) => count.fn.countAll<number>().as('held'))
          .where('r.task_id', '=', binds.taskId)
          .where('r.queue', '=', binds.queue)
          .as('runs'),
        eb
          .selectFrom('checkpoints as c')
          .select((count) => count.fn.countAll<number>().as('held'))
          .where('c.task_id', '=', binds.taskId)
          .as('checkpoints'),
        eb
          .selectFrom('waits as w')
          .select((count) => count.fn.countAll<number>().as('held'))
          .where('w.run_id', 'in', (runs) =>
            runs
              .selectFrom('runs as wr')
              .select('wr.run_id')
              .where('wr.task_id', '=', binds.taskId)
              .where('wr.queue', '=', binds.queue),
          )
          .as('waits'),
        eb
          .selectFrom('events as e')
          .select((count) => count.fn.countAll<number>().as('held'))
          .where('e.queue', '=', binds.queue)
          .where('e.event_name', '=', taskDoneEventName(binds.taskId))
          .as('events'),
      ])
      .where('f.task_id', '=', binds.taskId)
      .where('f.fence_stamp', '=', fenceValue('purge')),
)

/**
 * `purge-unit`'s last statement: the task row the compare-and-set stamped, by its key. It
 * goes last because every other delete of the batch finds its rows through this row's
 * stamp.
 */
export const purgedTaskDelete = defineStatement(
  'purge-unit task',
  (binds: { queue: string; taskId: string }) =>
    treeBuilder
      .deleteFrom('tasks')
      .where('task_id', '=', binds.taskId)
      .where('queue', '=', binds.queue)
      .where('fence_stamp', '=', fenceValue('purge')),
)

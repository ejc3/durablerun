import { expressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  insertedFrom,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { type AwaitingClaim, stillClaimed } from './events.js'
import { insertedRun } from './successor.js'

/**
 * `spawn`'s compare-and-set: insert the task, unless its identity is taken. A taken
 * idempotency key loses through the partial unique index the conflict clause names,
 * and a taken task id loses through the store's identity predicate, so neither raises.
 * The enqueue and cancellation deadlines and their headroom guards are the store's,
 * read together with its own casts.
 */
export const spawnTaskCas = defineStatement(
  'spawn',
  (binds: {
    taskId: string
    queue: string
    taskName: string
    paramsJson: string
    headersJson: string | null
    retryStrategyJson: string
    maxAttempts: number
    cancellationJson: string | null
    idempotencyKey: string | null
    /** Database time plus the start delay. */
    enqueueAt: SqlFragment
    /** The start deadline `max_delay` sets, or NULL without one. */
    cancelAt: SqlFragment
    /** No task has this id, and no run already names it. */
    identityFree: SqlFragment
    enqueueFits: SqlFragment
    cancelFits: SqlFragment
    /**
     * The parent's live claim, for a child task, or null for any other spawn. `phase` is
     * what the saga phase requires of a child spawn (DESIGN.md §3.10): a child is forward
     * progress, and the forward phase is frozen once a saga began. It is a predicate and
     * never `'open'`: no store may answer that the phase asks nothing of a child spawn.
     */
    parent: (AwaitingClaim & { liveTask: SqlFragment; phase: SqlFragment }) | null
  }) => {
    const eb = expressionBuilder<StoreTables, never>()
    const task = {
      task_id: eb.val(binds.taskId),
      queue: eb.val(binds.queue),
      task_name: eb.val(binds.taskName),
      params: eb.val(binds.paramsJson),
      headers: eb.val(binds.headersJson),
      retry_strategy: eb.val(binds.retryStrategyJson),
      max_attempts: eb.val(binds.maxAttempts),
      cancellation: eb.val(binds.cancellationJson),
      idempotency_key: eb.val(binds.idempotencyKey),
      state: eb.val('pending'),
      enqueue_at_ms: rawSql<number>(binds.enqueueAt, 'value'),
      cancel_at_ms: rawSql<number | null>(binds.cancelAt, 'value'),
      created_at_ms: nowValue,
      ...FENCE_ASSIGNMENTS,
    }
    const { columns, selections } = insertedFrom(task)
    const admitted = treeBuilder
      .selectNoFrom(selections)
      .where(rawSql<boolean>(binds.identityFree, 'predicate'))
      .where(rawSql<boolean>(binds.enqueueFits, 'predicate'))
      .where(rawSql<boolean>(binds.cancelFits, 'predicate'))
    // ChildTasks.tla's SpawnAuthority: a child is created only under its parent's live
    // claim, and only while the saga phase admits one. The conflict arm below still finds
    // a child that exists, claim or none, in either phase.
    const parent = binds.parent
    return treeBuilder
      .insertInto('tasks')
      .columns(columns)
      .expression(
        parent === null
          ? admitted
          : admitted
              .where((where) => where.exists(stillClaimed(parent, parent.liveTask)))
              .where(rawSql<boolean>(parent.phase, 'predicate')),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['queue', 'idempotency_key'])
          .where('idempotency_key', 'is not', null)
          .doNothing(),
      )
  },
)

/**
 * `spawn`'s first run, for the task this batch inserted under the compare-and-set named
 * `task`. The task's stamp does not tell this execution from an exact replay of it, so
 * the insert also requires that the task has no run yet. That is a question about
 * ownership, which does not decay.
 */
export const spawnRunInsert = defineStatement(
  'spawn run',
  (binds: {
    runId: string
    taskId: string
    /** The task's stored enqueue instant is one the run can take. */
    enqueueStored: SqlFragment
  }) => {
    const eb = expressionBuilder<{ f: StoreTables['tasks'] }, 'f'>()
    const { columns, selections } = insertedRun({
      runId: binds.runId,
      attempt: eb.val(1),
      state: eb.val('pending'),
      availableAt: eb.ref('f.enqueue_at_ms'),
      carriedFrom: null,
    })
    return treeBuilder
      .insertInto('runs')
      .columns(columns)
      .expression(
        treeBuilder
          .selectFrom('tasks as f')
          .select(selections)
          .where('f.task_id', '=', binds.taskId)
          .where('f.fence_stamp', '=', fenceValue('task'))
          .where(rawSql<boolean>(binds.enqueueStored, 'predicate'))
          .where((where) =>
            where.not(
              where.exists(
                where
                  .selectFrom('runs as r')
                  .select('r.run_id')
                  .whereRef('r.task_id', '=', 'f.task_id'),
              ),
            ),
          ),
      )
  },
)

/**
 * `spawn`'s receipt, read only when the insert lost: the task that holds the identity.
 * It is an open read, because another caller created that task, and what fences it is
 * the unique idempotency index and not this batch's stamp.
 *
 * The store's predicate admits two kinds of task in this queue, which cannot overlap:
 * the one with this task id, and one with this idempotency key under another id. The
 * key's winner sorts first, then the task id breaks ties, so the answer is the same on
 * every dialect. The run reported is the winner's top attempt, or none.
 */
export const spawnReceiptRead = defineStatement(
  'spawn receipt',
  (binds: {
    taskId: string
    /** The task `t` holds this task id, or this idempotency key, in this queue. */
    winner: SqlFragment
    /** The store's join of a run `r` to the task `t` that owns it. */
    taskOwnsRun: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('tasks as t')
      .select((eb) => [
        eb.ref('t.task_id').as('task_id'),
        eb
          .selectFrom('runs as r')
          .select('r.run_id')
          .where(rawSql<boolean>(binds.taskOwnsRun, 'predicate'))
          .orderBy('r.attempt', 'desc')
          .limit(1)
          .as('run_id'),
      ])
      .where(rawSql<boolean>(binds.winner, 'predicate'))
      .orderBy((eb) =>
        eb.case().when('t.task_id', '=', binds.taskId).then(eb.lit(1)).else(eb.lit(0)).end(),
      )
      .orderBy('t.task_id')
      .limit(1),
)

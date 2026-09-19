import { type SqlFragment, aliasedAs, defineStatement, literalValue, rawSql } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { TASK_RESULT_COLUMN_LIST } from '../task-result.js'

/**
 * The reads a store sends outside a transition. Each is one SELECT of a batch that only
 * reads (`FencedBatch.readTree`). A store's predicates reach a read as fragments, as they
 * reach every shared statement: a condition on a state or on a stored instant stays the
 * dialect's own text, so a partial index still sees the literal it was declared with. A
 * state a read compares from nodes is written inline (`literalValue`), and a batch of
 * reads refuses one that is bound.
 */

/**
 * The seed of every batch that only reads. A read writes no stamp, so its batch needs no
 * id of its own, and drawing one would shift every id a seeded test predicts.
 */
export const READS_SEED = 'reads'

/**
 * Why the sweep's two discovery reads may see different clocks, the reason `readTree`
 * asks of the second. A task sitting exactly on a deadline can appear in one and not the
 * other, and then it waits for the next sweep.
 */
export const SWEEP_SCAN_DRIFT =
  'read-only discovery: every item is checked again under its own fence, at the instant of its own batch'

/** `refusal-state`: a refused run's state, read only after its fence refused a write or a heartbeat. */
export const refusalStateRead = defineStatement('refusal-state', (binds: { runId: string }) =>
  treeBuilder.selectFrom('runs').select('state').where('run_id', '=', binds.runId),
)

/** `run-task`: the task of the run a terminal batch is about to end, in this queue alone. */
export const runTaskRead = defineStatement('run-task', (binds: { queue: string; runId: string }) =>
  treeBuilder
    .selectFrom('runs')
    .select('task_id')
    .where('run_id', '=', binds.runId)
    .where('queue', '=', binds.queue),
)

/**
 * `task-result`: exactly the columns `decodeTaskResult` reads, of one task of one queue,
 * and the two values `decodeRollbackOutcome` reads. A rollback outcome is stored nowhere:
 * the store derives both values from the saga's checkpoints, so they are its fragments,
 * and this statement gives them the names the decoder reads.
 */
export const taskResultRead = defineStatement(
  'task-result',
  (binds: {
    queue: string
    taskId: string
    rollbackOutcome: SqlFragment
    rollbackError: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('tasks')
      .select([...TASK_RESULT_COLUMN_LIST])
      .select(() => [
        aliasedAs(rawSql<string | null>(binds.rollbackOutcome, 'value'), 'rollback_outcome'),
        aliasedAs(rawSql<string | null>(binds.rollbackError, 'value'), 'rollback_error'),
      ])
      .where('task_id', '=', binds.taskId)
      .where('queue', '=', binds.queue),
)

/**
 * `task-done-state`: a task as a child await sees it. The queue is read, never bound: the
 * await refuses a child of another queue by what this row says.
 */
export const taskDoneStateRead = defineStatement('task-done-state', (binds: { taskId: string }) =>
  treeBuilder
    .selectFrom('tasks')
    .select(['queue', 'fence_stamp', ...TASK_RESULT_COLUMN_LIST])
    .where('task_id', '=', binds.taskId),
)

/**
 * `claimed-task-name`: the launch carries only ids, so the worker learns the claimed
 * task's name here. The name is immutable, so an unfenced read is safe. The claim
 * conditions only make a stale or already-activated launch read nothing.
 */
export const claimedTaskNameRead = defineStatement(
  'claimed-task-name',
  (binds: {
    queue: string
    runId: string
    claimToken: string
    claimGen: number
    /** The task `t` owns the run `r`. */
    taskOwnsRun: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('runs as r')
      .innerJoin('tasks as t', (join) => join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')))
      .select('t.task_name')
      .where('r.run_id', '=', binds.runId)
      .where('r.queue', '=', binds.queue)
      .where('r.claimed_by', '=', binds.claimToken)
      .where('r.state', '=', literalValue('running'))
      .where('r.claim_gen', '=', binds.claimGen)
      .where('r.activated_gen', '<', binds.claimGen),
)

/** `get-checkpoints`: a task's committed checkpoints whose owner ran no later than an attempt. */
export const checkpointsRead = defineStatement(
  'get-checkpoints',
  (binds: {
    queue: string
    taskId: string
    visibleThrough: number
    /** The run `owner` is the one the checkpoint `c` names as its owner. */
    ownerMatches: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('checkpoints as c')
      .innerJoin('runs as owner', (join) =>
        join.on(rawSql<boolean>(binds.ownerMatches, 'predicate')),
      )
      .select(['c.checkpoint_name', 'c.state', 'c.owner_run_id', 'c.owner_attempt'])
      .where('c.task_id', '=', binds.taskId)
      .where('c.queue', '=', binds.queue)
      .where('c.status', '=', literalValue('committed'))
      .where('c.owner_attempt', '<=', binds.visibleThrough)
      .orderBy('c.checkpoint_name'),
)

/**
 * `sweep:scan`'s first read: tasks whose cancellation deadline is due, oldest deadline
 * first, each with its newest live run. `due` is the store's whole admission of the task
 * `t`: its queue, the due deadline, its live state, and that it owns every run.
 */
export const sweepDueCancelsRead = defineStatement(
  'sweep:scan cancels',
  (binds: {
    limit: number
    due: SqlFragment
    /** The run `r` is a live run of the task `t`. */
    liveRunOfTask: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('tasks as t')
      .select((eb) => [
        eb.ref('t.task_id').as('task_id'),
        eb
          .selectFrom('runs as r')
          .select('r.run_id')
          .where(rawSql<boolean>(binds.liveRunOfTask, 'predicate'))
          .orderBy('r.attempt', 'desc')
          .limit(eb.lit(1))
          .as('run_id'),
      ])
      .where(rawSql<boolean>(binds.due, 'predicate'))
      .orderBy('t.cancel_at_ms')
      .orderBy('t.task_id')
      .limit(binds.limit),
)

/**
 * `sweep:scan`'s second read: running runs whose claim expired, oldest expiry first.
 * `expired` is the store's whole admission of the run `r` and its task `t`.
 */
export const sweepExpiredClaimsRead = defineStatement(
  'sweep:scan expired',
  (binds: {
    limit: number
    /** The task `t` owns the run `r`. */
    taskOwnsRun: SqlFragment
    expired: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('runs as r')
      .innerJoin('tasks as t', (join) => join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')))
      .select(['r.run_id', 'r.task_id', 'r.claim_gen', 'r.activated_gen', 'r.relaunch_count'])
      .where(rawSql<boolean>(binds.expired, 'predicate'))
      .orderBy('r.claim_expires_at_ms')
      .orderBy('r.run_id')
      .limit(binds.limit),
)

/**
 * `next-wake`: the earliest instant anything in a queue comes due, or NULL. Each leg is
 * the minimum of one stored instant under the store's own predicate, which names the
 * queue, the state, and the bounds a stored instant must be within. The legs stay apart,
 * joined by UNION ALL, so each is answered from its own index.
 */
export const nextWakeRead = defineStatement(
  'next-wake',
  (binds: {
    pendingRuns: SqlFragment
    sleepingRuns: SqlFragment
    runningRuns: SqlFragment
    cancellableTasks: SqlFragment
  }) => {
    const available = (runs: SqlFragment) =>
      treeBuilder
        .selectFrom('runs as r')
        .select((eb) => eb.fn.min('r.available_at_ms').as('v'))
        .where(rawSql<boolean>(runs, 'predicate'))
    const legs = available(binds.pendingRuns)
      .unionAll(available(binds.sleepingRuns))
      .unionAll(
        treeBuilder
          .selectFrom('runs as r')
          .select((eb) => eb.fn.min('r.claim_expires_at_ms').as('v'))
          .where(rawSql<boolean>(binds.runningRuns, 'predicate')),
      )
      .unionAll(
        treeBuilder
          .selectFrom('tasks as t')
          .select((eb) => eb.fn.min('t.cancel_at_ms').as('v'))
          .where(rawSql<boolean>(binds.cancellableTasks, 'predicate')),
      )
    return treeBuilder
      .selectFrom(legs.as('wakes'))
      .select((eb) => eb.fn.min('wakes.v').as('wake_ms'))
  },
)

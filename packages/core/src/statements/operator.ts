import { expressionBuilder } from 'kysely'
import {
  type SqlFragment,
  aliasedAs,
  defineStatement,
  literalValue,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { type QueueTable, type StoreTables, treeBuilder } from '../store-tables.js'
import { TASK_RESULT_COLUMN_LIST } from '../task-result.js'
import { admittedRuns, dueCancelRows, rollbackSelections } from './reads.js'
import { RETRY_CONJUNCTS, type RetryConjuncts } from './retry-task.js'

/**
 * The reads of the operator's port (`OperatorReads`), each one SELECT of a batch that only
 * reads. They select what an operator needs to see why a task is where it is, and no value
 * a task's code wrote beyond the outcome `getTaskResult` already answers with: no params,
 * headers, event payload, run result or checkpoint state.
 *
 * None orders its rows. A text column sorts by the database's collation, which differs
 * between the dialects and between two servers of one dialect, so the implementation
 * orders every list itself.
 */

/**
 * `task-facts`' task: one task of one queue, and database time as that read saw it. It is
 * the one statement of its batch that reads the clock. It selects the columns
 * `decodeTaskResult` reads and the two values `decodeRollbackOutcome` reads, through the
 * list and the selections `task-result` selects them through, so the outcome is decoded by
 * the decoders `getTaskResult` calls and by nothing else. Whether the saga began is a flag, 1 or 0, written inline.
 */
export const taskFactsTaskRead = defineStatement(
  'task-facts task',
  (binds: {
    queue: string
    taskId: string
    /** The saga of the row `tasks` began. */
    sagaBegan: SqlFragment
    rollbackOutcome: SqlFragment
    rollbackError: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('tasks')
      .select([
        ...TASK_RESULT_COLUMN_LIST,
        'task_name',
        'attempts',
        'max_attempts',
        'infra_retries',
        'enqueue_at_ms',
        'first_started_at_ms',
        'cancel_at_ms',
        'idempotency_key',
      ])
      .select((eb) => [
        ...rollbackSelections(binds),
        aliasedAs(nowValue, 'now_ms'),
        eb
          .case()
          .when(rawSql<boolean>(binds.sagaBegan, 'predicate'))
          .then(literalValue(1))
          .else(literalValue(0))
          .end()
          .as('saga_began'),
      ])
      .where('task_id', '=', binds.taskId)
      .where('queue', '=', binds.queue),
)

/**
 * `task-facts`' runs: every run that names the task, each with the event that woke it or
 * that it is parked on, when that event exists. The runs are found by the task's id alone,
 * so a run that names another queue is reported and not hidden.
 */
export const taskFactsRunsRead = defineStatement('task-facts runs', (binds: { taskId: string }) =>
  treeBuilder
    .selectFrom('runs as r')
    .leftJoin('events as e', (join) =>
      join.onRef('e.queue', '=', 'r.queue').onRef('e.event_name', '=', 'r.wake_event'),
    )
    .select([
      'r.run_id',
      'r.queue',
      'r.state',
      'r.attempt',
      'r.claim_gen',
      'r.activated_gen',
      'r.relaunch_count',
      'r.claim_expires_at_ms',
      'r.heartbeat_at_ms',
      'r.available_at_ms',
      'r.wake_event',
      'r.wake_step',
      'r.started_at_ms',
      'r.completed_at_ms',
      'r.failed_at_ms',
    ])
    .select((eb) => [
      eb.ref('e.event_name').as('emitted_event'),
      eb.ref('e.emitted_at_ms').as('emitted_at_ms'),
    ])
    .where('r.task_id', '=', binds.taskId),
)

/**
 * `task-facts`' waits: every wait registered by a run of the task, each with its event when
 * the event exists. `waits` has no index on a task, so the waits are reached through the
 * task's runs, by the key of each.
 */
export const taskFactsWaitsRead = defineStatement('task-facts waits', (binds: { taskId: string }) =>
  treeBuilder
    .selectFrom('runs as r')
    .innerJoin('waits as w', 'w.run_id', 'r.run_id')
    .leftJoin('events as e', (join) =>
      join.onRef('e.queue', '=', 'w.queue').onRef('e.event_name', '=', 'w.event_name'),
    )
    .select([
      'w.run_id',
      'w.step_name',
      'w.event_name',
      'w.status',
      'w.timeout_at_ms',
      'w.created_at_ms',
    ])
    .select((eb) => [
      eb.ref('e.event_name').as('emitted_event'),
      eb.ref('e.emitted_at_ms').as('emitted_at_ms'),
    ])
    .where('r.task_id', '=', binds.taskId),
)

/** `task-id-by-key`: the task of a queue that was spawned under an idempotency key. */
export const taskIdByKeyRead = defineStatement(
  'task-id-by-key',
  (binds: { queue: string; idempotencyKey: string }) =>
    treeBuilder
      .selectFrom('tasks')
      .select('task_id')
      .where('queue', '=', binds.queue)
      .where('idempotency_key', '=', binds.idempotencyKey),
)

/** `event-state`: when one event of a queue was emitted. Its payload is not selected. */
export const eventStateRead = defineStatement(
  'event-state',
  (binds: { queue: string; eventName: string }) =>
    treeBuilder
      .selectFrom('events')
      .select('emitted_at_ms')
      .where('queue', '=', binds.queue)
      .where('event_name', '=', binds.eventName),
)

/**
 * `table-rows`: how many rows of one table one queue holds, counted up to a cap. The inner
 * SELECT stops one row past the cap, so the count is exact up to the cap, and one more than
 * the cap when the queue holds more than that. The database reads no row past that one.
 */
export const tableRowsRead = defineStatement(
  'table-rows',
  (binds: { table: QueueTable; queue: string; cap: number }) =>
    treeBuilder
      .selectFrom(
        treeBuilder
          .selectFrom(binds.table)
          .select('queue')
          .where('queue', '=', binds.queue)
          .limit(binds.cap + 1)
          .as('counted'),
      )
      .select((eb) => eb.fn.countAll<number>().as('row_count')),
)

/** The instant a leg of runs is ordered by, and the column that holds it. */
export type RunInstant = 'available_at_ms' | 'claim_expires_at_ms'
const runInstant = (instant: RunInstant) =>
  instant === 'available_at_ms' ? 'r.available_at_ms' : 'r.claim_expires_at_ms'

/**
 * One leg of `stuck-runs` over runs: the runs a store's predicate admits, each with its
 * task's name, oldest instant first (`admittedRuns`). `admitted` is the predicate the
 * engine's own statement holds: a claim's candidates of one state, or the sweep's expired
 * claims. The leg of leases also selects the two generations, which say whether the lost
 * claim was started.
 */
export const overdueRunsRead = defineStatement(
  'stuck-runs runs',
  (binds: { limit: number; taskOwnsRun: SqlFragment; admitted: SqlFragment; dueAt: RunInstant }) =>
    admittedRuns(binds, runInstant(binds.dueAt)).select([
      'r.run_id',
      'r.task_id',
      't.task_name',
      'r.attempt',
      runInstant(binds.dueAt),
      ...(binds.dueAt === 'claim_expires_at_ms'
        ? (['r.claim_gen', 'r.activated_gen'] as const)
        : ([] as const)),
    ]),
)

/**
 * The leg of `stuck-runs` over tasks: the tasks the sweep's scan of due cancellations
 * takes (`dueCancelRows`), each with its name, its state and its deadline.
 */
export const overdueCancelsRead = defineStatement(
  'stuck-runs cancels',
  (binds: Parameters<typeof dueCancelRows>[0]) =>
    dueCancelRows(binds).select(['t.task_name', 't.state', 't.cancel_at_ms']),
)

/**
 * A window of `stuck-runs` over runs: the runs a store's predicate takes by their instant
 * alone, oldest first, up to a limit. `rows` names the queue, the state, and that the
 * instant has come, and requires nothing else of the run or of its task: no task is joined.
 * The engine's own leg is read beside it, and a run of the window that the engine's leg
 * does not answer is one the engine does not take.
 */
export const overdueRunsWindowRead = defineStatement(
  'stuck-runs window runs',
  (binds: { limit: number; rows: SqlFragment; dueAt: RunInstant }) =>
    treeBuilder
      .selectFrom('runs as r')
      .select(['r.run_id', 'r.task_id', 'r.attempt', runInstant(binds.dueAt)])
      .where(rawSql<boolean>(binds.rows, 'predicate'))
      .orderBy(runInstant(binds.dueAt))
      .orderBy('r.run_id')
      .limit(binds.limit),
)

/** A window of `stuck-runs` over tasks: the live tasks past their cancellation deadline, oldest deadline first. */
export const overdueTasksWindowRead = defineStatement(
  'stuck-runs window tasks',
  (binds: { limit: number; rows: SqlFragment }) =>
    treeBuilder
      .selectFrom('tasks as t')
      .select(['t.task_id', 't.task_name', 't.state', 't.cancel_at_ms'])
      .where(rawSql<boolean>(binds.rows, 'predicate'))
      .orderBy('t.cancel_at_ms')
      .orderBy('t.task_id')
      .limit(binds.limit),
)

/**
 * Database time, as a statement of its own. A report of a queue dates itself with it, last
 * in its batch, because a queue may hold no row to select the clock beside.
 */
export const databaseNowRead = defineStatement('database-now', (_binds: Record<never, never>) =>
  treeBuilder.selectNoFrom(aliasedAs(nowValue, 'now_ms')),
)

/**
 * One leg of `queue-status` over runs: one instant of every run a store's predicate takes,
 * earliest first, up to a limit. `rows` names the queue, the state, and that the instant
 * is stored at all, and holds the instant to no bounds: a gauge counts a stored instant
 * its bounds refuse, and the read that decodes it lists it.
 */
export const runInstantsRead = defineStatement(
  'queue-status runs',
  (binds: { limit: number; rows: SqlFragment; instant: RunInstant }) =>
    treeBuilder
      .selectFrom('runs as r')
      .select(['r.run_id', runInstant(binds.instant)])
      .where(rawSql<boolean>(binds.rows, 'predicate'))
      .orderBy(runInstant(binds.instant))
      .orderBy('r.run_id')
      .limit(binds.limit),
)

/** The leg of `queue-status` over tasks: the cancellation deadline of every live task that has one. */
export const taskDeadlinesRead = defineStatement(
  'queue-status deadlines',
  (binds: { limit: number; rows: SqlFragment }) =>
    treeBuilder
      .selectFrom('tasks as t')
      .select(['t.task_id', 't.cancel_at_ms'])
      .where(rawSql<boolean>(binds.rows, 'predicate'))
      .orderBy('t.cancel_at_ms')
      .orderBy('t.task_id')
      .limit(binds.limit),
)

/**
 * The live tasks a store's predicate takes, in the order they were enqueued, up to a limit.
 * `rows` names the queue and one live state and compares the enqueue instant, so the index
 * of live tasks hands the rows out oldest first, and it holds the instant to no bounds.
 */
const liveTaskRows = (binds: { limit: number; rows: SqlFragment }) =>
  treeBuilder
    .selectFrom('tasks as t')
    .where(rawSql<boolean>(binds.rows, 'predicate'))
    .orderBy('t.enqueue_at_ms')
    .orderBy('t.task_id')
    .limit(binds.limit)

/** A leg of `aged-tasks`: those live tasks (`liveTaskRows`), each with its name and its state. */
export const liveTasksRead = defineStatement(
  'live-tasks',
  (binds: Parameters<typeof liveTaskRows>[0]) =>
    liveTaskRows(binds).select(['t.task_id', 't.task_name', 't.state', 't.enqueue_at_ms']),
)

/**
 * A leg of the gauge of live tasks in `queue-status`: the same rows, each with its id and
 * its enqueue instant and nothing else. A gauge counts rows and dates the oldest, so it
 * selects no column the index of live tasks does not hold where that index holds the
 * table's key, and the index then answers the leg with no read of the table.
 */
export const liveTaskInstantsRead = defineStatement(
  'queue-status live-tasks',
  (binds: Parameters<typeof liveTaskRows>[0]) =>
    liveTaskRows(binds).select(['t.task_id', 't.enqueue_at_ms']),
)

/**
 * `event-waiters`: the waits of a queue registered on one event that are still waiting,
 * in the order of their key, which is the run and then the step, up to a limit. The list
 * an operator is answered keeps this order, so the limit cuts where the list does. A wait
 * holds its task, so the task of each is read from the wait's own row.
 */
export const eventWaitersRead = defineStatement(
  'event-waiters',
  (binds: { queue: string; eventName: string; limit: number }) =>
    treeBuilder
      .selectFrom('waits as w')
      .select(['w.task_id', 'w.run_id', 'w.step_name', 'w.timeout_at_ms'])
      .where('w.queue', '=', binds.queue)
      .where('w.event_name', '=', binds.eventName)
      .where('w.status', '=', literalValue('waiting'))
      .orderBy('w.run_id')
      .orderBy('w.step_name')
      .limit(binds.limit),
)

/**
 * `event-payload`: one event's stored payload, with how the dialect names the type of the
 * stored value. It is read for the payload's digest alone: the operator who emits an event
 * that already exists is told which payload the first emit stored, by its hash.
 */
export const eventPayloadRead = defineStatement(
  'event-payload',
  (binds: { queue: string; eventName: string; payloadType: SqlFragment }) =>
    treeBuilder
      .selectFrom('events')
      .select('payload')
      .select(() => [aliasedAs(rawSql<string>(binds.payloadType, 'value'), 'payload_type')])
      .where('queue', '=', binds.queue)
      .where('event_name', '=', binds.eventName),
)

const ofTheTask = expressionBuilder<StoreTables, 'tasks'>()

/**
 * A store's predicate as a flag of a SELECT list: 1 when it holds of the row, and 0 when it
 * does not or is NULL. A guard that holds the same predicate admits the row exactly when
 * the flag is 1, because a guard takes NULL for a refusal too.
 */
const flagOf = <Alias extends string>(predicate: SqlFragment, alias: Alias) =>
  ofTheTask
    .case()
    .when(rawSql<boolean>(predicate, 'predicate'))
    .then(literalValue(1))
    .else(literalValue(0))
    .end()
    .as(alias)

/**
 * `task-admission`'s first read: every conjunct of the retry guard as a flag of its own,
 * over the one task of the queue. `failed` is the conjunct `reviveCas` holds itself, and
 * the rest are the store's, the predicates its admission is built from (`retryAdmission`).
 */
export const taskAdmissionRetryRead = defineStatement(
  'task-admission retry',
  (binds: { queue: string; taskId: string; conjuncts: RetryConjuncts }) =>
    treeBuilder
      .selectFrom('tasks')
      .select(() => [
        ofTheTask
          .case()
          .when(ofTheTask('state', '=', literalValue('failed')))
          .then(literalValue(1))
          .else(literalValue(0))
          .end()
          .as('failed'),
        ...RETRY_CONJUNCTS.map((name) => flagOf(binds.conjuncts[name], name)),
      ])
      .where('task_id', '=', binds.taskId)
      .where('queue', '=', binds.queue),
)

/**
 * `task-admission`'s second read: whether the sweep's scan of due cancellations takes the
 * task now, with the state and the deadline the answer was read beside. `dueCancels` is
 * the store's whole admission of the task `t`, the one its sweep reads by.
 */
export const taskAdmissionSweepRead = defineStatement(
  'task-admission sweep',
  (binds: { queue: string; taskId: string; dueCancels: SqlFragment }) =>
    treeBuilder
      .selectFrom('tasks as t')
      .select(['t.state', 't.cancel_at_ms'])
      .select(() => [flagOf(binds.dueCancels, 'sweepCancels')])
      .where('t.task_id', '=', binds.taskId)
      .where('t.queue', '=', binds.queue),
)

/**
 * `task-admission`'s third read: every run that names the task, each with whether a claim
 * takes it now and whether the sweep's scan of expired claims does, and with the state, the
 * generation and the instants those answers were read beside. Each flag is the predicate
 * the engine's own statement holds, over the run `r` and the task `t` that owns it. A run
 * whose task is not in its queue joins no task, and every flag of it is 0.
 */
export const taskAdmissionRunsRead = defineStatement(
  'task-admission runs',
  (binds: {
    taskId: string
    /** The task `t` owns the run `r`. */
    taskOwnsRun: SqlFragment
    pendingRuns: SqlFragment
    sleepingRuns: SqlFragment
    expiredClaims: SqlFragment
  }) =>
    treeBuilder
      .selectFrom('runs as r')
      .leftJoin('tasks as t', (join) => join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')))
      .select([
        'r.run_id',
        'r.state',
        'r.attempt',
        'r.claim_gen',
        'r.available_at_ms',
        'r.claim_expires_at_ms',
      ])
      .select(() => [
        flagOf(binds.pendingRuns, 'claimTakesPending'),
        flagOf(binds.sleepingRuns, 'claimTakesSleeping'),
        flagOf(binds.expiredClaims, 'sweepReclaims'),
      ])
      .where('r.task_id', '=', binds.taskId),
)

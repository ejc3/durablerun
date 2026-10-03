import {
  type SqlFragment,
  aliasedAs,
  defineStatement,
  literalValue,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { TASK_RESULT_COLUMN_LIST } from '../task-result.js'
import { rollbackSelections } from './reads.js'

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

import { expressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  insertedFrom,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'

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
    return treeBuilder
      .insertInto('tasks')
      .columns(columns)
      .expression(
        treeBuilder
          .selectNoFrom(selections)
          .where(rawSql<boolean>(binds.identityFree, 'predicate'))
          .where(rawSql<boolean>(binds.enqueueFits, 'predicate'))
          .where(rawSql<boolean>(binds.cancelFits, 'predicate')),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['queue', 'idempotency_key'])
          .where('idempotency_key', 'is not', null)
          .doNothing(),
      )
  },
)

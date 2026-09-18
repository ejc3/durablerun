import { expressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  rawSql,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { whereTaskInQueue } from './claimed-run.js'
import { insertedRun } from './successor.js'

/**
 * `retry-task`'s compare-and-set: a task returns to pending, charged for its top run,
 * with one more attempt in its budget and its reason cleared. It requires the failed
 * state itself and consumes it, so a replay matches nothing and cannot raise the budget
 * twice. The store's admission predicate requires a well-formed failure, which a
 * registered mutation owns as store text, and says what the task's runs and counters
 * must look like. The store computes the charge.
 */
export const reviveCas = defineStatement(
  'retry-task',
  (binds: {
    queue: string
    taskId: string
    /** The revival run, recorded as the task's last attempt. */
    runId: string
    /** The user attempts the task is charged with: its top ordinal net of infrastructure retries. */
    charged: SqlFragment
    admission: SqlFragment
  }) =>
    treeBuilder
      .updateTable('tasks')
      .set((eb) => ({
        state: 'pending',
        attempts: rawSql<number>(binds.charged, 'value'),
        max_attempts: eb('max_attempts', '+', 1),
        failure_reason: null,
        last_attempt_run: binds.runId,
        ...FENCE_ASSIGNMENTS,
      }))
      .$call(whereTaskInQueue(binds))
      .where('state', '=', 'failed')
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

/**
 * `retry-task`'s revival run, for the task this batch revived under the compare-and-set
 * named `revive`: one attempt past the task's top run `p`, carrying what that run
 * carried, and due at the revival's own instant.
 */
export const revivalRunInsert = defineStatement(
  'retry-task run',
  (binds: {
    runId: string
    taskId: string
    /** The store's join of a run `p` to the revived task `f` that owns it. */
    taskOwnsRun: SqlFragment
    /** The run `p` is the task's top attempt. */
    isTopRun: SqlFragment
    /** The task has no live run, which an exact replay of the revival would find. */
    noLiveRun: SqlFragment
  }) => {
    const eb = expressionBuilder<{ f: StoreTables['tasks']; p: StoreTables['runs'] }, 'f' | 'p'>()
    const { columns, selections } = insertedRun({
      runId: binds.runId,
      attempt: eb('p.attempt', '+', 1),
      state: eb.val('pending'),
      availableAt: eb.ref('f.fence_at_ms'),
      carriedFrom: 'p',
    })
    return treeBuilder
      .insertInto('runs')
      .columns(columns)
      .expression(
        treeBuilder
          .selectFrom('tasks as f')
          .innerJoin('runs as p', (join) =>
            join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')),
          )
          .select(selections)
          .where('f.task_id', '=', binds.taskId)
          .where('f.fence_stamp', '=', fenceValue('revive'))
          .where(rawSql<boolean>(binds.isTopRun, 'predicate'))
          .where(rawSql<boolean>(binds.noLiveRun, 'predicate')),
      )
  },
)

/** `retry-task`'s read of the run this batch inserted, under the follow-on named `run`. */
export const revivedRunRead = defineStatement('retry-task revived', (binds: { runId: string }) =>
  treeBuilder
    .selectFrom('runs')
    .select('attempt')
    .where('run_id', '=', binds.runId)
    .where('fence_stamp', '=', fenceValue('run')),
)

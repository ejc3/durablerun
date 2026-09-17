import { FENCE_ASSIGNMENTS, type SqlFragment, defineStatement, rawSql } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { whereTaskInQueue } from './claimed-run.js'

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

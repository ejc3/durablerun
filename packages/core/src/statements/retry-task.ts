import { type SqlFragment, defineStatement, nowValue, rawSql, stampValue } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'

/**
 * `retry-task`'s compare-and-set: a task returns to pending, charged for its top run,
 * with one more attempt in its budget and its reason cleared. The store's admission
 * predicate requires the failed state and a well-formed failure, which registered
 * mutations own as store text, and says what the task's runs and counters must look
 * like. It consumes the failed state, so a replay matches nothing and cannot raise the
 * budget twice. The store computes the charge.
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
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      }))
      .where('task_id', '=', binds.taskId)
      .where('queue', '=', binds.queue)
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

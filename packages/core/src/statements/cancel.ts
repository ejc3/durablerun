import { type SqlFragment, defineStatement, nowValue, rawSql, stampValue } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { LIVE_STATES } from '../types.js'

/**
 * The compare-and-set `cancel-task` and the deadline sweep share: a live task becomes
 * cancelled with its reason, and its deadline is consumed. The store's admission
 * predicate holds the ownership check, and the due deadline when the sweep cancels.
 */
export const cancelCas = defineStatement(
  'cancel',
  (binds: { queue: string; taskId: string; reason: string; admission: SqlFragment }) =>
    treeBuilder
      .updateTable('tasks')
      .set({
        state: 'cancelled',
        cancelled_at_ms: nowValue,
        cancel_at_ms: null,
        failure_reason: binds.reason,
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      })
      .where('task_id', '=', binds.taskId)
      .where('queue', '=', binds.queue)
      .where('state', 'in', [...LIVE_STATES])
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

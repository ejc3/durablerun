import { REASON_CANCELLED } from '../contract.js'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { LIVE_STATES } from '../types.js'
import { whereTaskInQueue } from './claimed-run.js'

/**
 * The compare-and-set `cancel-task` and the deadline sweep share: a live task becomes
 * cancelled with the engine's cancellation reason, and its deadline is consumed. The store's admission
 * predicate holds the ownership check, and the due deadline when the sweep cancels.
 */
export const cancelCas = defineStatement(
  'cancel',
  (binds: { queue: string; taskId: string; admission: SqlFragment }) =>
    treeBuilder
      .updateTable('tasks')
      .set({
        state: 'cancelled',
        cancelled_at_ms: nowValue,
        cancel_at_ms: null,
        failure_reason: REASON_CANCELLED,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereTaskInQueue(binds))
      .where('state', 'in', [...LIVE_STATES])
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

import { type SqlFragment, defineStatement, nowValue, rawSql, stampValue } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'

/**
 * `complete`'s compare-and-set, defined once for every dialect. A store supplies its
 * task admission predicate, built from its own fragments.
 */
export const completeCas = defineStatement(
  'complete',
  (binds: {
    runId: string
    queue: string
    claimToken: string
    resultJson: string
    taskAdmitsCompletion: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        state: 'completed',
        completed_at_ms: nowValue,
        result: binds.resultJson,
        wake_event: null,
        event_payload: null,
        wake_step: null,
        claimed_by: null,
        claim_expires_at_ms: null,
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      })
      .where('run_id', '=', binds.runId)
      .where('queue', '=', binds.queue)
      .where('claimed_by', '=', binds.claimToken)
      .where('state', '=', 'running')
      .where(rawSql<boolean>(binds.taskAdmitsCompletion, 'predicate')),
)

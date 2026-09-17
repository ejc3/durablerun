import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { CLEARED_WAKE_COLUMNS, whereClaimedRun } from './claimed-run.js'

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
        ...CLEARED_WAKE_COLUMNS,
        claimed_by: null,
        claim_expires_at_ms: null,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereClaimedRun(binds))
      .where(rawSql<boolean>(binds.taskAdmitsCompletion, 'predicate')),
)

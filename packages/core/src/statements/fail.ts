import { FENCE_ASSIGNMENTS, type SqlFragment, defineStatement, rawSql } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { failedRunColumns, whereClaimedRun } from './claimed-run.js'

/**
 * `fail`'s compare-and-set: a run still running under its claim fails with its reason
 * and gives up the claim. The store's admission predicate says what the owning task
 * must look like, and carries the retry deadline's headroom guard when a retry follows.
 */
export const failCas = defineStatement(
  'fail',
  (binds: {
    queue: string
    runId: string
    claimToken: string
    failureJson: string
    admission: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        ...failedRunColumns(binds.failureJson),
        claim_expires_at_ms: null,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereClaimedRun(binds))
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

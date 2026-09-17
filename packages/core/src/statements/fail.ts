import { expressionBuilder } from 'kysely'
import { FENCE_ASSIGNMENTS, type SqlFragment, defineStatement, rawSql } from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { failedRunColumns, whereClaimedRun } from './claimed-run.js'
import { type FailureSuccessor, failureSuccessor } from './successor.js'

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

/**
 * `fail`'s retry run, placed while the task has user budget left. It is due at once
 * when the retry carries no delay, and asleep until the delay has run otherwise. The
 * cast tells PostgreSQL the type of a bind that is compared with nothing but a bind.
 */
export const userRetrySuccessorInsert = defineStatement(
  'fail successor',
  (binds: FailureSuccessor & { retryDelayMs: number }) => {
    const eb = expressionBuilder<StoreTables, never>()
    const state = eb
      .case()
      .when(eb.cast<number>(eb.val(binds.retryDelayMs), 'bigint'), '<=', 0)
      .then('pending')
      .else('sleeping')
      .end()
    return failureSuccessor(binds, state)
  },
)

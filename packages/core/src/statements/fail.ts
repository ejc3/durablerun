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
    /** What the saga phase requires of this failure, when it requires anything (§3.10). */
    phase?: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        ...failedRunColumns(binds.failureJson),
        claim_expires_at_ms: null,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereClaimedRun(binds))
      .where(rawSql<boolean>(binds.admission, 'predicate'))
      .$if(binds.phase !== undefined, (query) =>
        query.where(rawSql<boolean>(binds.phase as SqlFragment, 'predicate')),
      ),
)

/**
 * `fail`'s retry run, placed while the task has user budget left. It is due at once
 * when the retry carries no delay, and asleep until the delay has run otherwise. The
 * delay is a number the caller holds, so the state is decided before the statement is
 * built and bound as a value. No dialect then has to type a bind that is compared with
 * nothing but a bind.
 */
/**
 * A rollback pass (DESIGN.md §3.10, specs/Sagas.tla): the run that carries a saga on
 * once its task's terminal failure is decided, or once a rollback attempt failed with
 * budget left. It is the failed run's successor as a retry is, and the store's admission
 * says which of the two it is. The user budget does not cap it. It is due at once when it
 * enters the phase, and after the rollback's own delay otherwise.
 */
export const rollbackPassInsert = defineStatement(
  'rollback pass',
  (binds: FailureSuccessor & { delayMs: number; fence: 'fail' | 'cap' }) =>
    failureSuccessor(
      binds,
      expressionBuilder<StoreTables, never>().val(binds.delayMs <= 0 ? 'pending' : 'sleeping'),
      binds.fence,
    ),
)

export const userRetrySuccessorInsert = defineStatement(
  'fail successor',
  (binds: FailureSuccessor) =>
    failureSuccessor(
      binds,
      expressionBuilder<StoreTables, never>().val(binds.delayMs <= 0 ? 'pending' : 'sleeping'),
    ),
)

import type { SagaPhasePredicate } from '../sagas.js'
import { type SqlFragment, defineStatement, rawSql } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { CLEARED_WAKE_COLUMNS, whereClaimedRun } from './claimed-run.js'
import { parkAssignments } from './park.js'

/**
 * The compare-and-set `reschedule` and `suspend` share: a run still running under its
 * claim parks itself and drops any event wake it carried. The store's admission
 * predicate says what each requires of the run and its task.
 */
export const suspendCas = defineStatement(
  'suspend',
  (binds: {
    queue: string
    runId: string
    claimToken: string
    wakeAt: SqlFragment
    wakeFits: SqlFragment
    admission: SqlFragment
    /** What the saga phase requires of this park (§3.10). */
    phase: SagaPhasePredicate
  }) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        ...parkAssignments(eb, binds.wakeAt),
        ...CLEARED_WAKE_COLUMNS,
      }))
      .$call(whereClaimedRun(binds))
      .where(rawSql<boolean>(binds.admission, 'predicate'))
      .where(rawSql<boolean>(binds.wakeFits, 'predicate'))
      .$if(binds.phase !== 'open', (query) =>
        query.where(rawSql<boolean>(binds.phase as SqlFragment, 'predicate')),
      ),
)

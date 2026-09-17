import { type SqlFragment, defineStatement, rawSql } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
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
  }) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        ...parkAssignments(eb, binds.wakeAt),
        wake_event: null,
        event_payload: null,
        wake_step: null,
      }))
      .where('run_id', '=', binds.runId)
      .where('queue', '=', binds.queue)
      .where('claimed_by', '=', binds.claimToken)
      .where('state', '=', 'running')
      .where(rawSql<boolean>(binds.admission, 'predicate'))
      .where(rawSql<boolean>(binds.wakeFits, 'predicate')),
)

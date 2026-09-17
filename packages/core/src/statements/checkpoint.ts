import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { whereClaimedRun } from './claimed-run.js'

/**
 * `set-checkpoint`'s compare-and-set: a run still running under its claim, for this
 * task, extends its lease and takes the stamp the checkpoint write fences on. The lease
 * deadline and its headroom guard are the store's, read together with its own casts.
 */
export const checkpointLeaseCas = defineStatement(
  'set-checkpoint',
  (binds: {
    queue: string
    taskId: string
    runId: string
    claimToken: string
    leaseExpiresAt: SqlFragment
    admission: SqlFragment
    leaseFits: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        claim_expires_at_ms: rawSql<number>(binds.leaseExpiresAt, 'value'),
        heartbeat_at_ms: nowValue,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereClaimedRun(binds))
      .where('task_id', '=', binds.taskId)
      .where(rawSql<boolean>(binds.admission, 'predicate'))
      .where(rawSql<boolean>(binds.leaseFits, 'predicate')),
)

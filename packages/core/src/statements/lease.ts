import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'

/**
 * `heartbeat`'s compare-and-set. MySQL has no RETURNING, and every dialect sends one shape,
 * so the remainder is a second statement: the first stamps the run and the second reads
 * the row under that stamp, which can only see a lease this batch extended.
 */
export const heartbeatCas = defineStatement(
  'heartbeat',
  (binds: {
    queue: string
    runId: string
    claimToken: string
    /** Database time plus the extension, beside `leaseFits`, the headroom guard that protects it. */
    leaseExpiresAt: SqlFragment
    leaseFits: SqlFragment
    taskIsLive: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        claim_expires_at_ms: rawSql<number>(binds.leaseExpiresAt, 'value'),
        heartbeat_at_ms: nowValue,
        ...FENCE_ASSIGNMENTS,
      })
      .where('run_id', '=', binds.runId)
      .where('queue', '=', binds.queue)
      .where('claimed_by', '=', binds.claimToken)
      .where('state', '=', 'running')
      .where(rawSql<boolean>(binds.taskIsLive, 'predicate'))
      .where(rawSql<boolean>(binds.leaseFits, 'predicate')),
)

/**
 * `heartbeat`'s remainder: the two instants the compare-and-set named `extend` stored,
 * subtracted. It reads no clock, so the answer cannot drift from the write.
 */
export const heartbeatRemainingRead = defineStatement(
  'heartbeat remaining',
  (binds: { runId: string }) =>
    treeBuilder
      .selectFrom('runs')
      .select((eb) => eb('claim_expires_at_ms', '-', eb.ref('heartbeat_at_ms')).as('remaining_ms'))
      .where('run_id', '=', binds.runId)
      .where('fence_stamp', '=', fenceValue('extend')),
)

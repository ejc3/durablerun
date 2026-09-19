import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  aliasedAs,
  defineStatement,
  fenceValue,
  nowValue,
  rawSql,
  treeBuilder,
} from '@durablerun/core'

/**
 * `heartbeat`'s compare-and-set, for a dialect with no RETURNING. The other stores extend
 * the lease and read the remainder in one statement. Here the remainder is a second
 * statement, so the first stamps the run and the second reads the row under that stamp:
 * it can only see a lease this batch extended.
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

/**
 * `next-wake` on MySQL: the earliest instant anything in a queue comes due, or NULL. The
 * other stores take the minimum of each source, which MySQL does not answer from an index.
 * Here each leg is the store's own scalar subquery, the first row of its source in index order,
 * with the index hint inside it: the grammar lists no hint, so a hint stays in a fragment,
 * as the claim's does. A source with no row reads NULL, which MIN passes over.
 */
export const nextWakeRead = defineStatement(
  'next-wake',
  (binds: { legs: readonly SqlFragment[] }) => {
    const [first, ...rest] = binds.legs.map((leg) =>
      treeBuilder.selectNoFrom(aliasedAs(rawSql<number | null>(leg, 'value'), 'v')),
    )
    if (first === undefined) throw new Error('next-wake reads at least one wake source')
    const legs = rest.reduce((all, leg) => all.unionAll(leg), first)
    return treeBuilder
      .selectFrom(legs.as('wakes'))
      .select((eb) => eb.fn.min('wakes.v').as('wake_ms'))
  },
)

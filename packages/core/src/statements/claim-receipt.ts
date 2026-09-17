import type { UpdateQueryBuilder, UpdateResult } from 'kysely'
import { type SqlFragment, defineStatement, nowValue, rawSql, stampValue } from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'

/** The claim a launch names: a run still running under this token and generation, not yet activated. */
type ClaimReceipt = {
  queue: string
  runId: string
  claimToken: string
  claimGen: number
  /** The store's admission predicate for a claim receipt, the same for every transition that acts on one. */
  admission: SqlFragment
}

type RunsUpdate = UpdateQueryBuilder<StoreTables, 'runs', 'runs', UpdateResult>

/**
 * What every transition acting on a claim receipt requires of it: the receipt's
 * identity, the generation latch, and the store's admission predicate. Activation and
 * the launch deferral both apply this, so a guard added here reaches both.
 */
const whereClaimReceipt =
  (binds: ClaimReceipt) =>
  (update: RunsUpdate): RunsUpdate =>
    update
      .where('run_id', '=', binds.runId)
      .where('queue', '=', binds.queue)
      .where('claimed_by', '=', binds.claimToken)
      .where('state', '=', 'running')
      .where('claim_gen', '=', binds.claimGen)
      .where('activated_gen', '<', binds.claimGen)
      .where(rawSql<boolean>(binds.admission, 'predicate'))

/** The claim columns a parked run clears, so it carries no live token, lease deadline, or heartbeat. */
export const PARKED_CLAIM_COLUMNS = {
  claimed_by: null,
  claim_expires_at_ms: null,
  heartbeat_at_ms: null,
} as const

/**
 * `claim`'s compare-and-set. The candidate subquery is the store's, because libSQL
 * bounds each state's leg before merging them and PostgreSQL locks candidates with
 * SKIP LOCKED. A run held under this token refuses the whole claim, which is what makes
 * a same-token retry a receipt.
 */
export const claimCas = defineStatement(
  'claim',
  (binds: {
    queue: string
    claimToken: string
    leaseMs: number
    /** A parenthesized subquery of the due, eligible run ids, in claim order. */
    candidateRunIds: SqlFragment
    /** The step of a wait registered before runs carried `wake_step`. */
    legacyWaitStep: SqlFragment
    /**
     * The lease deadline: database time plus the lease. It stays store-owned, beside
     * `leaseFits`, the headroom guard that protects it, so the two are read together.
     */
    leaseExpiresAt: SqlFragment
    leaseFits: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        state: 'running',
        claimed_by: binds.claimToken,
        claim_gen: eb('claim_gen', '+', 1),
        lease_ms: binds.leaseMs,
        claim_expires_at_ms: rawSql<number>(binds.leaseExpiresAt, 'value'),
        heartbeat_at_ms: nowValue,
        wake_step: eb.fn.coalesce('wake_step', rawSql<string>(binds.legacyWaitStep, 'value')),
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      }))
      .where((eb) => eb('run_id', 'in', rawSql<string>(binds.candidateRunIds, 'subquery')))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('runs as held')
              .select('held.run_id')
              .where('held.queue', '=', binds.queue)
              .where('held.state', '=', 'running')
              .where('held.claimed_by', '=', binds.claimToken),
          ),
        ),
      )
      .where(rawSql<boolean>(binds.leaseFits, 'predicate')),
)

/**
 * `activate`'s compare-and-set: the per-claim generation latch. It re-extends the
 * lease, so a launch the channel delayed does not start life nearly expired.
 */
export const activateCas = defineStatement(
  'activate',
  (binds: ClaimReceipt & { leaseExpiresAt: SqlFragment; leaseFits: SqlFragment }) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        activated_gen: binds.claimGen,
        started_at_ms: eb.fn.coalesce('started_at_ms', nowValue),
        claim_expires_at_ms: rawSql<number>(binds.leaseExpiresAt, 'value'),
        heartbeat_at_ms: nowValue,
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      }))
      .$call(whereClaimReceipt(binds))
      .where(rawSql<boolean>(binds.leaseFits, 'predicate')),
)

/**
 * `defer-launch`'s compare-and-set: park a claimed run that was never activated. The
 * first-start latch, the start deadline, and the wake fields stay untouched.
 */
export const deferLaunchCas = defineStatement(
  'defer-launch',
  (binds: ClaimReceipt & { wakeAt: SqlFragment; wakeFits: SqlFragment }) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        state: eb
          .case()
          .when(rawSql<number>(binds.wakeAt, 'value'), '<=', nowValue)
          .then('pending')
          .else('sleeping')
          .end(),
        available_at_ms: rawSql<number>(binds.wakeAt, 'value'),
        ...PARKED_CLAIM_COLUMNS,
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      }))
      .$call(whereClaimReceipt(binds))
      .where(rawSql<boolean>(binds.wakeFits, 'predicate')),
)

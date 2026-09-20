import type { SqlRow } from '../primitives.js'
import { normalizeRetryStrategy } from '../retry.js'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import type { ClaimedRun } from '../types.js'
import {
  RUN_INTEGER_BOUNDS,
  TASK_INTEGER_BOUNDS,
  parseTaskValueJson,
  persistedPositiveClaimGeneration,
  persistedRowInteger,
} from '../validate.js'
import { type RunsUpdate, claimedRunRows, whereClaimedRun } from './claimed-run.js'
import { parkAssignments } from './park.js'

/** The claim a launch names: a run still running under this token and generation, not yet activated. */
type ClaimReceipt = {
  queue: string
  runId: string
  claimToken: string
  claimGen: number
  /** The store's admission predicate for a claim receipt, the same for every transition that acts on one. */
  admission: SqlFragment
}

/**
 * What every transition acting on a claim receipt requires of it: the receipt's
 * identity, the generation latch, and the store's admission predicate. Activation and
 * the launch deferral both apply this, so a guard added here reaches both.
 */
const whereClaimReceipt =
  (binds: ClaimReceipt) =>
  (update: RunsUpdate): RunsUpdate =>
    whereClaimedRun(binds)(update)
      .where('claim_gen', '=', binds.claimGen)
      .where('activated_gen', '<', binds.claimGen)
      .where(rawSql<boolean>(binds.admission, 'predicate'))

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
        ...FENCE_ASSIGNMENTS,
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
        ...FENCE_ASSIGNMENTS,
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
      .set((eb) => parkAssignments(eb, binds.wakeAt))
      .$call(whereClaimReceipt(binds))
      .where(rawSql<boolean>(binds.wakeFits, 'predicate')),
)

/**
 * `claim`'s receipt: every run this queue holds under the claim token, in run order. It
 * is an open read, keyed on the lease token and not on this batch's stamp, so a retry
 * with the same token returns the original selection, which an earlier batch stamped
 * (§3.4 rule 4). The token's identity is nodes, so a store fragment cannot leave it
 * out. The store's admission says what a run and its task must look like to be handed
 * to a worker.
 */
export const claimReceiptRead = defineStatement(
  'claim picked',
  (binds: {
    queue: string
    claimToken: string
    taskOwnsRun: SqlFragment
    admission: SqlFragment
  }) =>
    claimedRunRows(binds.taskOwnsRun)
      .where('r.queue', '=', binds.queue)
      .where('r.claimed_by', '=', binds.claimToken)
      .where('r.state', '=', 'running')
      .where(rawSql<boolean>(binds.admission, 'predicate'))
      .orderBy('r.run_id'),
)

/**
 * `activate`'s payload: the run this batch activated, under the compare-and-set named
 * `activate`, with what its worker needs to start.
 */
export const activatedRunRead = defineStatement(
  'activate payload',
  (binds: { runId: string; taskOwnsRun: SqlFragment }) =>
    claimedRunRows(binds.taskOwnsRun)
      .where('r.run_id', '=', binds.runId)
      .where('r.fence_stamp', '=', fenceValue('activate'))
      .where('r.state', '=', 'running'),
)

/**
 * A claimed run, decoded from one row of `claimReceiptRead` or `activatedRunRead`, which both
 * select the columns of `claimedRunRows`, and the claim token the caller holds. Every dialect's
 * store decodes through this one function, so a worker is handed the same run whichever
 * database claimed it.
 */
export function decodeClaimedRun(row: SqlRow, claimToken: string): ClaimedRun {
  const claimed: ClaimedRun = {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    taskName: String(row.task_name),
    attempt: persistedRowInteger('claim', row, RUN_INTEGER_BOUNDS.attempt),
    infraRetries: persistedRowInteger('claim', row, TASK_INTEGER_BOUNDS.infra_retries),
    claimGen: persistedPositiveClaimGeneration('claim', row),
    claimToken,
    claimExpiresAtEpochMs: persistedRowInteger(
      'claim',
      row,
      RUN_INTEGER_BOUNDS.claim_expires_at_ms,
    ),
    leaseSeconds: persistedRowInteger('claim', row, RUN_INTEGER_BOUNDS.lease_ms) / 1000,
    paramsJson: String(row.params),
    retryStrategy: normalizeRetryStrategy(parseTaskValueJson(String(row.retry_strategy))),
    maxAttempts: persistedRowInteger('claim', row, TASK_INTEGER_BOUNDS.max_attempts),
    headers:
      row.headers === null
        ? {}
        : (parseTaskValueJson(String(row.headers)) as Record<string, string>),
  }
  if (row.wake_event !== null && row.wake_step !== null) {
    // The SDK matches on the exact step key. Rows parked before schema v3
    // carry it only in waits, so claim and emit copy it into the run before
    // deleting that registration. Never fabricate a step from the event name:
    // repeated awaits may share the event while using distinct step keys.
    const event = String(row.wake_event)
    const step = String(row.wake_step)
    claimed.wake =
      row.event_payload === null
        ? { event, step, timedOut: true }
        : { event, step, payloadJson: String(row.event_payload) }
  }
  return claimed
}

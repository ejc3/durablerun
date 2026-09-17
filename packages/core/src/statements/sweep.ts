import { REASON_CLAIM_TIMEOUT, REASON_RELAUNCH_CAP } from '../contract.js'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
import { PERSISTED_INTEGER_BOUNDS } from '../validate.js'
import type { RunsUpdate } from './claimed-run.js'
import { PARKED_CLAIM_COLUMNS } from './park.js'

/** The expired claim a sweep found: a run still running under the generation the scan read. */
type SweptClaim = { queue: string; runId: string; claimGen: number }

/**
 * What every lease sweep requires of the run it acts on. The generation is what makes
 * the scan's answer safe to act on: a run claimed again since then matches nothing.
 */
const whereSweptClaim =
  (binds: SweptClaim) =>
  (update: RunsUpdate): RunsUpdate =>
    update
      .where('run_id', '=', binds.runId)
      .where('queue', '=', binds.queue)
      .where('state', '=', 'running')
      .where('claim_gen', '=', binds.claimGen)

const RELAUNCH_CAP = PERSISTED_INTEGER_BOUNDS.runs.relaunch_count.max

/**
 * `sweep:lost-launch`'s reopen: a launch that never activated returns the same run to
 * pending, one relaunch on, due after the store's backoff. It consumes no attempt. The
 * count is safe in a compare-and-set, because the guard consumes the running state and
 * a replay matches nothing.
 */
export const reopenLostLaunchCas = defineStatement(
  'sweep:lost-launch reopen',
  (
    binds: SweptClaim & {
      /** The claim expired before its launch activated. */
      launchLost: SqlFragment
      /** Database time plus the relaunch backoff. */
      availableAt: SqlFragment
      liveOwner: SqlFragment
      backoffFits: SqlFragment
    },
  ) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        state: 'pending',
        ...PARKED_CLAIM_COLUMNS,
        relaunch_count: eb('relaunch_count', '+', 1),
        available_at_ms: rawSql<number>(binds.availableAt, 'value'),
        ...FENCE_ASSIGNMENTS,
      }))
      .$call(whereSweptClaim(binds))
      .where(rawSql<boolean>(binds.launchLost, 'predicate'))
      .where('relaunch_count', '<', RELAUNCH_CAP)
      .where(rawSql<boolean>(binds.liveOwner, 'predicate'))
      .where(rawSql<boolean>(binds.backoffFits, 'predicate')),
)

/**
 * `sweep:lost-launch`'s cap: a run at the relaunch cap fails, so a broken launcher
 * surfaces as failed work and never as an endless launch loop. The owner may be live or
 * already terminal.
 */
export const capLostLaunchCas = defineStatement(
  'sweep:lost-launch cap',
  (binds: SweptClaim & { launchLost: SqlFragment; owner: SqlFragment }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        state: 'failed',
        failed_at_ms: nowValue,
        claimed_by: null,
        claim_expires_at_ms: null,
        failure_reason: REASON_RELAUNCH_CAP,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereSweptClaim(binds))
      .where(rawSql<boolean>(binds.launchLost, 'predicate'))
      .where('relaunch_count', '=', RELAUNCH_CAP)
      .where(rawSql<boolean>(binds.owner, 'predicate')),
)

/**
 * `sweep:claim-timeout`'s compare-and-set: the activated worker died or was cut off, so
 * its run fails and gives up the token, which fences the dead worker's late writes a
 * second time. It is not `fail`: no worker holds a token to present, so it keys on the
 * generation the scan read, and the store's admission carries the successor's headroom.
 */
export const failClaimTimeoutCas = defineStatement(
  'sweep:claim-timeout',
  (binds: SweptClaim & { timedOut: SqlFragment; admission: SqlFragment }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        state: 'failed',
        failed_at_ms: nowValue,
        claimed_by: null,
        failure_reason: REASON_CLAIM_TIMEOUT,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereSweptClaim(binds))
      .where(rawSql<boolean>(binds.timedOut, 'predicate'))
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

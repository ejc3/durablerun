import { NOW_MS } from './time.js'

/**
 * Shared eligibility fragments — the ONLY place engine SQL may say what
 * "live", "cancellation due", or "eligible to proceed" mean. Every door
 * (claim, activate, sweep, cancel) composes these; none re-derives them.
 *
 * Why this file exists: the claim once re-derived task
 * eligibility without the cancellation-deadline predicate, so a task past
 * its deadline could be claimed and launched whenever the sweep budget ran
 * out before cancelling it. A predicate defined once cannot drift; a lint
 * (scripts/fragment-lint.py) fails any store SQL that writes an eligibility
 * comparison or a raw state list outside this file.
 */

/** Non-terminal states — tasks and runs still in play. */
export const LIVE = `('pending','running','sleeping')`

/**
 * The states a freshly created successor run can be in: waiting for its turn,
 * never yet claimed. Distinguishing a successor from the run it replaces by
 * ROLE and not only by id is load-bearing — see `successorWritten` below.
 */
export const QUEUED = `('pending','sleeping')`

/**
 * Proof that THIS batch created the successor run it minted an id for.
 *
 * A stamp names a BATCH, not a row. Asking only "does a run with the
 * successor's id carry this batch's stamp" is therefore answerable by any
 * other row the same batch stamped — and the batch always stamps the run it
 * is failing. When the minted successor id collided with the failing run's
 * id, that failing run answered yes: the retry path fired even though no
 * successor existed, and the terminal path, the only writer of the task's
 * failure reason, was skipped. Pinning the successor's role as well as its
 * id makes the failing run unable to impersonate it.
 */
export const successorWritten = (idParam: string): string =>
  `EXISTS (SELECT 1 FROM runs s
           WHERE s.run_id = ${idParam} AND s.claimed_by = $STAMP$ AND s.state IN ${QUEUED})`

/** A materialized cancellation deadline that has already passed. */
export const cancelDue = (col: string): string => `${col} IS NOT NULL AND ${col} <= ${NOW_MS}`

/** No cancellation deadline, or one still in the future. */
export const cancelNotDue = (col: string): string => `(${col} IS NULL OR ${col} > ${NOW_MS})`

/**
 * A task eligible to make forward progress (be claimed, be activated):
 * still live AND not past a due cancellation deadline. `t` is the alias
 * of the tasks table in the calling query.
 */
export const eligibleTask = (t: string): string =>
  `${t}.state IN ${LIVE} AND ${cancelNotDue(`${t}.cancel_at_ms`)}`

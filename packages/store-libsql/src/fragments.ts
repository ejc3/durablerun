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

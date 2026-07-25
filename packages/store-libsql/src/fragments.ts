import { STAMP } from '@durablerun/core'

/**
 * Shared SQL fragments — the ONLY place engine SQL may say what "live",
 * "cancellation due", "eligible to proceed", or "written by this batch" mean.
 * Every door (claim, activate, sweep, cancel) composes these; none re-derives
 * them.
 *
 * Why this file exists: the claim once re-derived task eligibility without the
 * cancellation-deadline predicate, so a task past its deadline could be
 * claimed and launched whenever the sweep budget ran out before cancelling it.
 * A predicate defined once cannot drift; a lint (scripts/fragment-lint.py)
 * fails any store SQL that writes an eligibility comparison or a raw state
 * list outside this file.
 */

/** Non-terminal states — tasks and runs still in play. */
export const LIVE = `('pending','running','sleeping')`

/** The states a freshly created successor run can be in: waiting for its turn. */
export const QUEUED = `('pending','sleeping')`

/**
 * Proof that a given statement of THIS batch wrote the row identified by
 * `key`, and the instant that statement recorded.
 *
 * These two go together and are written as one shape because they answer one
 * question. A follow-on cannot read the clock (§3.4 rule 8), so when it needs
 * an instant it takes the one the fenced row already carries — the same row it
 * is proving exists. `key` is the correlation, written against the alias `f`.
 */
export const fenced = (table: string, key: string, fence: string): string =>
  `EXISTS (SELECT 1 FROM ${table} f WHERE ${key} AND f.fence_stamp = ${fence})`

export const fencedAt = (table: string, key: string, fence: string): string =>
  `(SELECT f.fence_at_ms FROM ${table} f WHERE ${key} AND f.fence_stamp = ${fence})`

/**
 * The provenance a stamping follow-on writes: its own stamp, plus the instant
 * of the row it is following. One definition, so the pair can never be half
 * written — a fresh stamp beside a stale instant would be a lie about when the
 * row was last transitioned.
 */
export const fenceFrom = (table: string, key: string, fence: string): string =>
  `fence_stamp = ${STAMP}, fence_at_ms = ${fencedAt(table, key, fence)}`

/**
 * A cancellation deadline that has already passed, as of `at`.
 *
 * `at` is explicit at every call site and has no default: which instant a
 * comparison uses is precisely the thing that goes wrong. A compare-and-set
 * passes the batch's clock; a follow-on passes the fence_at_ms its CAS
 * recorded, because a follow-on re-reading the clock can disagree with the
 * CAS that admitted it and undo the transition it was supposed to complete.
 */
export const cancelDue = (col: string, at: string): string =>
  `${col} IS NOT NULL AND ${col} <= ${at}`

/** No cancellation deadline, or one still in the future as of `at`. */
export const cancelNotDue = (col: string, at: string): string =>
  `(${col} IS NULL OR ${col} > ${at})`

/**
 * A task eligible to make forward progress (be claimed, be activated): still
 * live AND not past a due cancellation deadline. `t` is the alias of the tasks
 * table in the calling query.
 */
export const eligibleTask = (t: string, at: string): string =>
  `${t}.state IN ${LIVE} AND ${cancelNotDue(`${t}.cancel_at_ms`, at)}`

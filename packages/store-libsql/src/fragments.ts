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
 * Successor identity, keyed on OWNERSHIP rather than on a fence.
 *
 * A fence proves a row carries a stamp right now. That is not the same as
 * proving this batch wrote it, and the difference is not academic: claiming a
 * run is itself a transition that re-stamps it, so a few seconds after a
 * failure created a successor, the successor no longer carries the failure's
 * stamp. A discriminator built on the stamp therefore answers "no successor"
 * about a successor that exists and is running — and the failure's terminal
 * arm kills a task whose retry is live under a worker, or its insert runs
 * again and dies on the unique (task_id, attempt) index, discarding a whole
 * tick. Ownership does not decay, so these ask about that instead.
 *
 * `mine` is the insert's guard: a run of MY task already sits at that id, so
 * there is nothing to create — which is what a replay looks like. It excludes
 * the run being REPLACED, so a minted id colliding with the parent is not
 * mistaken for an already-created successor; the insert then proceeds and
 * fails on the primary key, loudly.
 *
 * That exclusion is load-bearing. Letting the parent satisfy `mine` made the
 * insert write nothing, and every arm keyed on the successor wrote nothing
 * too, so what committed was a HALF-transition: in the sweep, a failed run
 * under a task still marked running, which no later claim or sweep can
 * rediscover; in a worker failure with retry budget left, a permanently
 * failed task the caller had asked to retry. A collision with a FOREIGN row
 * already failed loudly, and an id-generation failure against our own parent
 * is no less a failure — raising is strictly better than committing either
 * of those.
 *
 * `exists` is the terminal arm's guard, and it excludes the parent for a
 * different reason: the question there is whether a real successor exists,
 * and the parent standing at a colliding id is not one. Conflating the two
 * is what let a failing run answer for its own successor and skip the only
 * statement that records why the task failed.
 */
export const successor = {
  mine: (idParam: string, taskCol: string, selfParam: string): string =>
    `EXISTS (SELECT 1 FROM runs s
             WHERE s.run_id = ${idParam} AND s.task_id = ${taskCol}
               AND s.run_id <> ${selfParam})`,
  exists: (idParam: string, taskCol: string, selfParam: string): string =>
    `EXISTS (SELECT 1 FROM runs s
             WHERE s.run_id = ${idParam} AND s.task_id = ${taskCol}
               AND s.run_id <> ${selfParam})`,
}

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

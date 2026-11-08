import { spawningParent } from './child-tasks.js'
import { byCodePoints } from './operator-reads.js'
import type { Retention } from './ports.js'
import {
  PURGE_BARRIER_CONDITIONS,
  type PurgeAdmission,
  type PurgeBarrierCondition,
  type PurgeCandidate,
  type PurgeCursor,
  type PurgedUnit,
  type RetentionPolicy,
} from './types.js'
import { requirePositiveInt } from './validate.js'

/**
 * The walk of a purge over the retention port (DESIGN.md §3.12): the one way a caller goes
 * through a queue's candidates. A command, a test and a soak that each wrote the walk for
 * themselves differed in the size of a page and in when they stopped, and the pass one of
 * them showed was not the pass another ran. There is one, and it is here.
 *
 * It takes the port and calls nothing but the port's three methods, so it hands its caller
 * no way round the barrier: whether a unit goes is still decided by `purgeUnit`, inside the
 * statement that deletes. That is why core's entry exports it, where it exports no builder
 * of a purge.
 *
 * One walk is one pass from the oldest candidate. It lists the candidates a page at a time
 * and looks at each once: with `execute` it sends the unit's purge, and reads what the
 * barrier says of a unit the purge kept; without, it only reads. A pass is applied until it
 * lets nothing more go: the purge of a unit can be what another unit was waiting for, a
 * parent that could run again or a run that held an outcome, so a kept unit is tried again
 * when a unit the walk took since could be what kept it, and that is repeated until a round
 * takes nothing. A walk without `execute` deletes nothing, so it tries nothing again: it
 * reads each unit as the database stands.
 *
 * One number bounds a walk: `limit`, the most units it takes. Nothing bounds the candidates
 * it looks at but the queue. A walk sends a listing for every page of candidates, a purge
 * for every candidate it reaches, and a read of the barrier for every one it keeps, so a
 * queue whose kept units grow costs each walk more. `examined` says how many looks a walk
 * took. A walk that its limit stopped says `more`, and the same walk run again from the
 * oldest takes what the first left.
 */

/** The most candidates one listing of the walk asks for. A page is not the limit: a walk that takes one unit still reads its candidates a hundred at a time. */
export const PURGE_WALK_PAGE = 100

/** What bounds one walk. */
export interface PurgeWalkBounds {
  /** The most units the walk takes: purges, or without `execute` lists as ones a purge would take. */
  readonly limit: number
  /** Purge. Left out or false, the walk sends only reads and deletes nothing. */
  readonly execute?: boolean
}

/** A unit the walk took: with `execute`, the rows that went with it, and without, null. */
export interface PurgeWalkTaken {
  readonly candidate: PurgeCandidate
  readonly rows: PurgedUnit['rows'] | null
}

/** A unit the barrier keeps, with what each of its conditions said at the walk's last look. */
export interface PurgeWalkKept {
  readonly candidate: PurgeCandidate
  readonly admission: PurgeAdmission
}

/** The call of the port that failed, the task it was for, and what it threw. */
export interface PurgeWalkFailure {
  readonly call: keyof Retention
  readonly taskId?: string
  readonly error: unknown
}

/** What one walk did. */
export interface PurgeWalkReport {
  /** The units taken, in the order they were taken. */
  readonly taken: readonly PurgeWalkTaken[]
  /** The units the barrier keeps, oldest first. */
  readonly kept: readonly PurgeWalkKept[]
  /** The candidates that were not there when the walk looked: another purge took them, or a purge of this walk was delivered twice. */
  readonly gone: readonly PurgeCandidate[]
  /** The unit whose purge was sent and not answered. Whether it went is not known. */
  readonly outcomeNotKnown: readonly PurgeCandidate[]
  /** How many looks the walk took: first looks and second tries together. */
  readonly examined: number
  /**
   * False when the walk reached its end: every candidate was looked at, and no kept unit
   * was owed another try. True when its limit stopped it with a candidate unread or a kept
   * unit owed another try, and when a call failed: the same walk run again takes more.
   */
  readonly more: boolean
  /** The failure the walk stopped at, or null when every call was answered. */
  readonly failed: PurgeWalkFailure | null
}

/** The conditions of the barrier that the purge of another unit can make hold. */
const FREED_BY_A_PURGE: readonly PurgeBarrierCondition[] = Object.freeze([
  'noRunHoldsTheOutcome',
  'noWaitOnTheOutcome',
  'parentCannotRunAgain',
])

/** Whether every condition of the barrier held of a unit, as of a read. */
const letsGo = (admission: PurgeAdmission): boolean =>
  PURGE_BARRIER_CONDITIONS.every((condition) => admission.holds[condition])

/** A kept unit, and how many units the walk had taken when it last looked. */
interface Kept extends PurgeWalkKept {
  readonly asOf: number
}

export async function purgeWalk(
  retention: Retention,
  queue: string,
  policy: RetentionPolicy,
  bounds: PurgeWalkBounds,
): Promise<PurgeWalkReport> {
  const limit = requirePositiveInt('purgeWalk limit', bounds.limit)
  const execute = bounds.execute === true
  const taken: PurgeWalkTaken[] = []
  /** The place in `taken` of each unit taken, by its task. */
  const takenAt = new Map<string, number>()
  const kept = new Map<string, Kept>()
  const gone: PurgeCandidate[] = []
  const outcomeNotKnown: PurgeCandidate[] = []
  let examined = 0
  const atTheLimit = (): boolean => taken.length === limit

  /**
   * One look at a candidate: its purge, and what keeps it when the purge did not take it. A
   * unit leaves the list of kept units only when a look settles it.
   */
  const look = async (candidate: PurgeCandidate): Promise<PurgeWalkFailure | null> => {
    const { taskId } = candidate
    examined += 1
    if (execute) {
      let purged: PurgedUnit | null
      try {
        purged = await retention.purgeUnit(queue, candidate, policy)
      } catch (error) {
        // The batch was sent and no answer came: it may have committed.
        kept.delete(taskId)
        outcomeNotKnown.push(candidate)
        return { call: 'purgeUnit', taskId, error }
      }
      if (purged !== null) {
        kept.delete(taskId)
        takenAt.set(taskId, taken.length)
        taken.push({ candidate, rows: purged.rows })
        return null
      }
    }
    let admission: PurgeAdmission | null
    try {
      admission = await retention.purgeAdmission(queue, candidate, policy)
    } catch (error) {
      // A unit under a second try stays listed as kept, as it last read.
      return { call: 'purgeAdmission', taskId, error }
    }
    if (admission === null) {
      kept.delete(taskId)
      gone.push(candidate)
    } else if (!execute && letsGo(admission)) taken.push({ candidate, rows: null })
    else kept.set(taskId, { candidate, admission, asOf: taken.length })
    return null
  }

  /**
   * Whether a unit the walk took since its last look could be what kept this one. Every
   * condition that is false must be one a purge can make hold. A parent that could run
   * again is no longer there once the walk took the task the unit's key names. What held
   * an outcome or waited on it is a run of another task, which the read does not name, so
   * any unit taken since may have been it.
   */
  const owedAnotherTry = ({ candidate, admission, asOf }: Kept): boolean => {
    const notHeld = PURGE_BARRIER_CONDITIONS.filter((condition) => !admission.holds[condition])
    if (notHeld.length === 0) return false
    if (!notHeld.every((condition) => FREED_BY_A_PURGE.includes(condition))) return false
    if (admission.holds.parentCannotRunAgain) return taken.length > asOf
    const parent = spawningParent(candidate.idempotencyKey ?? null)
    if (!parent.known || parent.taskId === null) return false
    const at = takenAt.get(parent.taskId)
    return at !== undefined && at >= asOf
  }

  let failed: PurgeWalkFailure | null = null
  /** The limit stopped the first looks with a candidate unread. */
  let unread = false
  /** A kept unit is owed another try that the limit did not leave room for. */
  let owing = false
  let after: PurgeCursor | null = null

  // The first looks: every candidate, oldest first, a page at a time.
  list: for (;;) {
    let page: Awaited<ReturnType<Retention['purgeCandidates']>>
    try {
      page = await retention.purgeCandidates(queue, policy, {
        limit: PURGE_WALK_PAGE,
        ...(after === null ? {} : { after }),
      })
    } catch (error) {
      failed = { call: 'purgeCandidates', error }
      break
    }
    for (const candidate of page.candidates) {
      if (atTheLimit()) {
        unread = true
        break list
      }
      failed = await look(candidate)
      if (failed !== null) break list
    }
    if (page.next === null) break
    // The page says that a candidate follows it, so no listing is sent to learn that.
    if (atTheLimit()) {
      unread = true
      break
    }
    after = page.next
  }

  // The second tries, whether or not the limit stopped the first looks: the kept units a
  // unit taken since may have freed, round after round, until a round finds none. A round
  // is owed only after a take, so the rounds end. At the limit nothing more is taken, and
  // a unit that is owed a try says so through `more`.
  if (execute && failed === null) {
    rounds: for (;;) {
      const again = [...kept.values()].filter(owedAnotherTry)
      if (again.length === 0) break
      for (const { candidate } of again) {
        if (atTheLimit()) {
          owing = true
          break rounds
        }
        failed = await look(candidate)
        if (failed !== null) break rounds
      }
    }
  }

  return Object.freeze({
    taken: Object.freeze(taken),
    kept: Object.freeze(
      [...kept.values()]
        .sort(
          (left, right) =>
            left.candidate.endedAtMs - right.candidate.endedAtMs ||
            byCodePoints(left.candidate.taskId, right.candidate.taskId),
        )
        .map(({ candidate, admission }) => Object.freeze({ candidate, admission })),
    ),
    gone: Object.freeze(gone),
    outcomeNotKnown: Object.freeze(outcomeNotKnown),
    examined,
    more: failed !== null || unread || owing,
    failed,
  })
}

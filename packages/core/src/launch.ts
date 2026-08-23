import type { Ending, SchedulerStore } from './ports.js'
import type { LaunchIdentity } from './types.js'

type LaunchPayload =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'ended'; readonly ending: Ending }
  | { readonly kind: 'unidentified-ending' }
  | { readonly kind: 'launch-failed' }

const INVALID_LAUNCH: LaunchPayload = Object.freeze({ kind: 'launch-failed' })
const AUTHENTIC_LAUNCH_OUTCOMES = new WeakMap<object, LaunchPayload>()

/**
 * The result of asking a Launcher to start a worker — deliberately OPAQUE.
 *
 * Consumers cannot read its fields: the only way to act on an outcome is
 * `LaunchOutcome.reconcile`, which owns the full §3.9 discipline in one
 * place — parse whatever the (possibly plain-JS) transport returned,
 * ignore reports that do not identify this launch, and take every
 * non-accepted outcome through the same door: a best-effort advisory
 * expiry whose fence no-ops when the worker truly transitioned. This
 * makes the two bug classes of the tick review — trusting a report's
 * content and hand-rolling per-consumer handling — unwritable: there is
 * no affordance to branch on, and no second way to consume an outcome.
 *
 * Launcher implementations construct outcomes via the static factories.
 */
export class LaunchOutcome {
  /**
   * Authentication lives outside the instance shape. `instanceof` alone is
   * forgeable with Object.create(LaunchOutcome.prototype), and a private
   * TypeScript field is still an ordinary runtime property. Only this module's
   * factory can enroll an object in the registry. The runtime constructor
   * always throws: TypeScript privacy is erased and Reflect.construct can call
   * a merely-private constructor.
   */
  private constructor() {
    throw new TypeError('LaunchOutcome must be created by a static factory')
  }

  /** The transport took the launch (fire-and-forget ack). */
  static accepted(): LaunchOutcome {
    return authenticateLaunchOutcome({ kind: 'accepted' })
  }

  /** A sync (bounded-slot resident) launcher observed the worker end. */
  static ended(ending: Ending): LaunchOutcome {
    const snapshot = snapshotEnding(ending)
    if (snapshot.status !== 'identified') {
      // A recognizable tokenless ending is an authenticated no-op: it cannot
      // name a claim, and expiring whichever claim happens to own the run now
      // would race a newer worker. Other malformed payloads are failed
      // launches, because they provide no trustworthy evidence at all.
      return snapshot.status === 'tokenless'
        ? authenticateLaunchOutcome({ kind: 'unidentified-ending' })
        : LaunchOutcome.launchFailed()
    }
    return authenticateLaunchOutcome({
      kind: 'ended',
      ending: Object.freeze(snapshot.ending),
    })
  }

  /** The launch never left the building. */
  static launchFailed(): LaunchOutcome {
    return authenticateLaunchOutcome(INVALID_LAUNCH)
  }

  /**
   * The single consumption point. `value` is whatever the launcher call
   * produced (already-caught throws should be passed as `launchFailed`);
   * anything that is not a real LaunchOutcome counts as a failed launch.
   *
   * Returns the classification for the caller's counters:
   * - 'accepted'      — nothing written; the worker owns the run now.
   * - 'ended'         — an ending was observed (or a report that named a
   *                     DIFFERENT run or claim was ignored — it says nothing
   *                     about this launch).
   * - 'launch-failed' — the launch is not coming.
   *
   * Every non-accepted outcome that identifies this exact claim gets the SAME
   * advisory write: expire the lease now, so the next sweep classifies by
   * activation state. The fence inside expireLeaseNow IS the verification
   * — it no-ops when the worker truly completed/failed/rescheduled — and
   * the write is best-effort: a transient store error costs only the
   * acceleration, never the caller's result.
   */
  static async reconcile(
    store: SchedulerStore,
    queue: string,
    run: LaunchIdentity,
    value: unknown,
  ): Promise<'accepted' | 'ended' | 'launch-failed'> {
    const payload =
      value !== null && typeof value === 'object'
        ? (AUTHENTIC_LAUNCH_OUTCOMES.get(value) ?? INVALID_LAUNCH)
        : INVALID_LAUNCH
    if (payload.kind === 'accepted') return 'accepted'
    if (payload.kind === 'unidentified-ending') return 'ended'
    if (payload.kind === 'ended') {
      const { ending } = payload
      if (ending.runId !== run.runId || ending.claimToken !== run.claimToken) {
        return 'ended'
      }
    }
    try {
      await store.expireLeaseNow(queue, run.runId, run.claimToken)
    } catch {
      // advisory: acceleration lost, correctness unaffected
    }
    return payload.kind
  }
}

/**
 * The sole enrollment primitive. Constructing without running the public
 * constructor keeps runtime callers from invoking the enrollment path through
 * Reflect while preserving an opaque, frozen class instance for launchers.
 */
function authenticateLaunchOutcome(payload: LaunchPayload): LaunchOutcome {
  const outcome = Object.create(LaunchOutcome.prototype) as LaunchOutcome
  AUTHENTIC_LAUNCH_OUTCOMES.set(outcome, Object.freeze(payload))
  return Object.freeze(outcome)
}

const ENDING_KINDS = new Set<Ending['kind']>([
  'completed',
  'failed',
  'crashed',
  'timeout',
  'unknown',
])

type EndingSnapshot =
  | { readonly status: 'identified'; readonly ending: Ending }
  | { readonly status: 'tokenless' }
  | { readonly status: 'invalid' }

function snapshotEnding(value: unknown): EndingSnapshot {
  if (value === null || typeof value !== 'object') return { status: 'invalid' }
  let runId: unknown
  let claimToken: unknown
  let kind: unknown
  try {
    const candidate = value as Record<string, unknown>
    // Exactly one read each. User-controlled getters may throw or change
    // between reads; authentication operates only on this guarded snapshot.
    runId = candidate.runId
    claimToken = candidate.claimToken
    kind = candidate.kind
  } catch {
    return { status: 'invalid' }
  }
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    typeof kind !== 'string' ||
    !ENDING_KINDS.has(kind as Ending['kind'])
  ) {
    return { status: 'invalid' }
  }
  if (claimToken === undefined) return { status: 'tokenless' }
  if (typeof claimToken !== 'string' || claimToken.length === 0) {
    return { status: 'invalid' }
  }
  return {
    status: 'identified',
    ending: { runId, claimToken, kind: kind as Ending['kind'] },
  }
}

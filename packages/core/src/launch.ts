import type { Ending, SchedulerStore } from './ports.js'
import type { LaunchIdentity } from './types.js'

type LaunchPayload =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'ended'; readonly ending: Ending }
  | { readonly kind: 'launch-failed' }

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
  private constructor(private readonly payload: LaunchPayload) {}

  /** The transport took the launch (fire-and-forget ack). */
  static accepted(): LaunchOutcome {
    return new LaunchOutcome({ kind: 'accepted' })
  }

  /** A sync (bounded-slot resident) launcher observed the worker end. */
  static ended(ending: Ending): LaunchOutcome {
    return new LaunchOutcome({ kind: 'ended', ending })
  }

  /** The launch never left the building. */
  static launchFailed(): LaunchOutcome {
    return new LaunchOutcome({ kind: 'launch-failed' })
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
    const outcome = value instanceof LaunchOutcome ? value : LaunchOutcome.launchFailed()
    const payload = outcome.payload
    if (payload.kind === 'accepted') return 'accepted'
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

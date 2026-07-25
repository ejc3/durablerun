import type { Ending, SchedulerStore } from './ports.js'

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
  private constructor(
    private readonly kind: 'accepted' | 'ended' | 'launch-failed',
    private readonly ending: Ending | null,
  ) {}

  /** The transport took the launch (fire-and-forget ack). */
  static accepted(): LaunchOutcome {
    return new LaunchOutcome('accepted', null)
  }

  /** A sync (bounded-slot resident) launcher observed the worker end. */
  static ended(ending: Ending): LaunchOutcome {
    return new LaunchOutcome('ended', ending)
  }

  /** The launch never left the building. */
  static launchFailed(_error: unknown): LaunchOutcome {
    return new LaunchOutcome('launch-failed', null)
  }

  /**
   * The single consumption point. `value` is whatever the launcher call
   * produced (already-caught throws should be passed as `launchFailed`);
   * anything that is not a real LaunchOutcome counts as a failed launch.
   *
   * Returns the classification for the caller's counters:
   * - 'accepted'      — nothing written; the worker owns the run now.
   * - 'ended'         — an ending was observed (or a report that named a
   *                     DIFFERENT run was ignored — it says nothing about
   *                     this launch).
   * - 'launch-failed' — the launch is not coming.
   *
   * Every non-accepted outcome that identifies this run gets the SAME
   * advisory write: expire the lease now, so the next sweep classifies by
   * activation state. The fence inside expireLeaseNow IS the verification
   * — it no-ops when the worker truly completed/failed/rescheduled — and
   * the write is best-effort: a transient store error costs only the
   * acceleration, never the caller's result.
   */
  static async reconcile(
    store: SchedulerStore,
    queue: string,
    run: { runId: string; claimToken: string },
    value: unknown,
  ): Promise<'accepted' | 'ended' | 'launch-failed'> {
    const outcome =
      value instanceof LaunchOutcome
        ? value
        : LaunchOutcome.launchFailed(new Error('malformed launch outcome'))
    if (outcome.kind === 'accepted') return 'accepted'
    if (outcome.kind === 'ended' && outcome.ending?.runId !== run.runId) return 'ended'
    try {
      await store.expireLeaseNow(queue, run.runId, run.claimToken)
    } catch {
      // advisory: acceleration lost, correctness unaffected
    }
    return outcome.kind
  }
}

import {
  type IdSource,
  LaunchOutcome,
  type Launcher,
  requirePositiveInt,
  type SchedulerStore,
  type SweptRun,
} from '@durablerun/core'

/**
 * One bounded look at the queue (DESIGN.md §3.1). Stateless, idempotent,
 * safe to run concurrently and to die anywhere: all mutual exclusion is the
 * store's fencing, and a tick that crashes between claim and launch leaves
 * exactly the lost-launch state the next tick's sweep reopens.
 *
 * The same tick drives both modes: a resident driver loops
 * `tick(); sleep(min(nextWake, ceiling))`; a serverless deployment runs it
 * per ping/alarm/cron invocation and arms an alarm at `nextWakeAtEpochMs`.
 * Mode mechanics (sleeping, alarm re-arm, jitter) live in the caller — the
 * tick only computes and returns.
 */
export interface TickOptions {
  queue: string
  /** K: max runs claimed (and launched) per tick. */
  claimLimit: number
  /** K_s: max sweep transitions (cancellations + expiries) per tick. */
  sweepLimit: number
  /** Lease granted to claimed runs; workers re-extend via heartbeat. */
  leaseSeconds: number
}

export interface TickResult {
  /** Sweep transitions this tick performed (classified by the store). */
  swept: SweptRun[]
  /** Runs claimed by this tick's token. */
  claimed: number
  /** Launches the transport accepted (fire-and-forget acks). */
  launched: number
  /**
   * Launches that failed to leave the building (outcome 'launch-failed' or a
   * throwing launcher). Their leases were advisorily expired: the next
   * tick's sweep reopens them as lost-launch without waiting out the lease.
   */
  launchFailed: number
  /** Sync-launcher endings observed inline by a bounded-slot host. */
  ended: number
  /** min(next transition) across the queue, for the caller's re-arm. */
  nextWakeAtEpochMs: number | null
  /**
   * A budget was filled (swept ≥ K_s or claimed ≥ K): more work may be due
   * NOW. The caller fires an immediate successor tick — the tick chain is
   * the drain loop; cron resurrects a dead chain. This is a HINT, not the
   * whole truth: a legally short batch (buggify, contention) can leave due
   * work behind with backlog false — which `nextWakeAtEpochMs` <= now then
   * surfaces. Callers treat both signals as "look again immediately".
   */
  backlog: boolean
}

export async function tick(
  deps: { store: SchedulerStore; launcher: Launcher; ids: IdSource },
  opts: TickOptions,
): Promise<TickResult> {
  const { store, launcher, ids } = deps
  // Degenerate budgets are refused up front: a sweep budget of 0 would make
  // backlog vacuously true forever (an idle hot loop for a compliant
  // caller), and the store would reject the claim limit only mid-tick.
  requirePositiveInt('sweepLimit', opts.sweepLimit)
  requirePositiveInt('claimLimit', opts.claimLimit)

  // 1. Sweep first: cancellations enforce before claiming (a due-to-cancel
  //    task must never be claimed by the tick that should have cancelled
  //    it), and reopened/successor runs become claimable as early as the
  //    NEXT tick. Every transition inside is a fenced batch keyed on the
  //    per-item stamp — concurrent sweepers match zero rows structurally.
  const swept = await store.sweep(opts.queue, opts.sweepLimit)

  // 2. Claim: one fenced batch under a fresh per-tick token. The DB is the
  //    mutual exclusion — concurrent ticks split the backlog, never race.
  const claimToken = ids.token()
  const claimed = await store.claim(opts.queue, claimToken, {
    leaseSeconds: opts.leaseSeconds,
    limit: opts.claimLimit,
  })

  // 3. Launch each claimed run. Outcomes are ADVISORY (§3.9): the lease is
  //    the only truth about execution rights, so the strongest thing a bad
  //    outcome may do is ACCELERATE lease expiry (expireLeaseNow). If the
  //    signal is wrong and a worker did start, its heartbeat legitimately
  //    revives the lease — nothing is ever revoked from here.
  let launched = 0
  let launchFailed = 0
  let ended = 0
  await Promise.all(
    claimed.map(async (run) => {
      let raw: unknown
      try {
        raw = await launcher.launch({
          queue: opts.queue,
          runId: run.runId,
          taskName: run.taskName,
          attempt: run.attempt,
          claimToken: run.claimToken,
          claimGen: run.claimGen,
          deadlineHintEpochMs: run.claimExpiresAtEpochMs,
        })
      } catch {
        // A throwing transport is indistinguishable from a lost launch.
        raw = LaunchOutcome.launchFailed()
      }
      // ALL outcome semantics live in the reconciler (core/launch.ts):
      // parsing, identity checks, and the single advisory-expiry door.
      const kind = await LaunchOutcome.reconcile(store, opts.queue, run, raw)
      if (kind === 'accepted') launched++
      else if (kind === 'ended') ended++
      else launchFailed++
    }),
  )

  // 4. Next wake: computed, returned, never acted on here (mode-specific).
  const nextWakeAtEpochMs = await store.nextWakeAtEpochMs(opts.queue)

  return {
    swept,
    claimed: claimed.length,
    launched,
    launchFailed,
    ended,
    nextWakeAtEpochMs,
    backlog: swept.length >= opts.sweepLimit || claimed.length >= opts.claimLimit,
  }
}

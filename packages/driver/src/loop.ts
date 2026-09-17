import {
  type Clock,
  type IdSource,
  LaunchOutcome,
  type Launcher,
  type SchedulerStore,
  durationToMs,
  requirePositiveInt,
} from '@durablerun/core'
import { type TickOptions, type TickResult, tick } from './tick.js'

/**
 * The resident driver (DESIGN.md §3.1, resident mode): a tiny long-lived
 * loop around tick(). Each pass ticks, then sleeps until the earliest of
 * the queue's next-wake time and an adaptive poll ceiling — ~250ms while
 * work is flowing, backing off toward seconds when idle (an idle tick is
 * two reads of nothing; cheapness is what makes N drivers affordable).
 * `backlog` or an already-due wake means no sleep at all: the tick chain
 * drains the queue.
 *
 * wake() interrupts the current sleep immediately (the transport for
 * enqueue pings). stop() finishes the in-flight tick, cancels the pending
 * sleep, and resolves run() — no dangling timers, nothing orphaned; a
 * process killed harder than that is just the lost-launch/lease story the
 * store already recovers.
 *
 * Local-clock note: sleep durations compare the store's next-wake (database
 * time) against the injected Clock. In production both are wall clock and
 * skew only shifts a wake by its magnitude — harmless, since every wake
 * merely means "look". Tests align a fake Clock with the store's fake time.
 */
export interface DriverLoopOptions extends TickOptions {
  /** Poll ceiling while work is flowing (default 250ms). */
  busyCeilingMs?: number
  /** Poll ceiling once idle (default 5000ms). */
  idleCeilingMs?: number
  /** Consecutive empty ticks before the idle ceiling applies (default 10). */
  idleAfterTicks?: number
  /**
   * Minimum time between the starts of two ticks that a wake() may cause
   * (default: the busy ceiling). A flood of /wake pings looks at most once per
   * floor interval; stop() still interrupts the wait.
   */
  wakeFloorMs?: number
  /**
   * Abandon a hanging launcher call after this long (default 10s). Pass
   * null for bounded-slot SYNC launchers that legitimately run the worker
   * inline (§3.9) — their calls are supposed to take as long as the run.
   */
  launchTimeoutSeconds?: number | null
  /** Registry liveness row cadence (default 15s; ttl = 2x cadence). */
  registryIntervalSeconds?: number
  /** Registry identity (default: a fresh token). */
  driverId?: string
}

export interface DriverLoopStats {
  ticks: number
  tickErrors: number
  /** Cumulative across all ticks (lastResult is only the newest pass). */
  launched: number
  launchFailed: number
  ended: number
  lastResult: TickResult | null
}

export class DriverLoop {
  private readonly store: SchedulerStore
  private readonly launcher: Launcher
  private readonly ids: IdSource
  private readonly clock: Clock
  private readonly tickOpts: TickOptions
  private readonly busyCeilingMs: number
  private readonly idleCeilingMs: number
  private readonly idleAfterTicks: number
  private readonly wakeFloorMs: number
  private readonly registryIntervalMs: number
  private readonly registryTtlSeconds: number
  private readonly driverId: string

  private running = false
  private everRan = false
  private stopped: Promise<void> | null = null
  private resolveStopped: (() => void) | null = null
  private sleepInterrupt: AbortController | null = null
  private readonly floorInterrupt = new AbortController()
  private wakeRequested = false
  private idleTicks = 0
  private chainedTicks = 0
  private lastBeatAtMs: number | null = null
  private beatInFlight: Promise<void> | null = null
  readonly stats: DriverLoopStats = {
    ticks: 0,
    tickErrors: 0,
    launched: 0,
    launchFailed: 0,
    ended: 0,
    lastResult: null,
  }

  constructor(
    deps: { store: SchedulerStore; launcher: Launcher; ids: IdSource; clock: Clock },
    opts: DriverLoopOptions,
  ) {
    this.store = deps.store
    this.ids = deps.ids
    this.clock = deps.clock
    // The tick validates these too — but per-tick, where a bad value
    // throws into the outage catch forever. A misconfigured loop must
    // fail at construction, not impersonate a healthy process.
    requirePositiveInt('claimLimit', opts.claimLimit)
    requirePositiveInt('sweepLimit', opts.sweepLimit)
    durationToMs('leaseSeconds', opts.leaseSeconds, { positive: true })
    this.tickOpts = {
      queue: opts.queue,
      claimLimit: opts.claimLimit,
      sweepLimit: opts.sweepLimit,
      leaseSeconds: opts.leaseSeconds,
    }
    // Ceilings feed the timer API directly: past 2^31-1 ms a timer fires
    // IMMEDIATELY, turning the idle park into a hot loop.
    const MAX_TIMER_MS = 2_147_483_647
    this.busyCeilingMs = requirePositiveInt('busyCeilingMs', opts.busyCeilingMs ?? 250)
    this.idleCeilingMs = requirePositiveInt('idleCeilingMs', opts.idleCeilingMs ?? 5000)
    this.wakeFloorMs = requirePositiveInt('wakeFloorMs', opts.wakeFloorMs ?? this.busyCeilingMs)
    if (Math.max(this.busyCeilingMs, this.idleCeilingMs, this.wakeFloorMs) > MAX_TIMER_MS) {
      throw new RangeError(
        `poll ceilings and wakeFloorMs must be <= ${MAX_TIMER_MS}ms (timer API limit)`,
      )
    }
    if (this.idleCeilingMs < this.busyCeilingMs) {
      throw new RangeError('idleCeilingMs must be >= busyCeilingMs (idle must not poll faster)')
    }
    this.idleAfterTicks = requirePositiveInt('idleAfterTicks', opts.idleAfterTicks ?? 10)
    const registryIntervalSeconds = opts.registryIntervalSeconds ?? 15
    this.registryIntervalMs = durationToMs('registryIntervalSeconds', registryIntervalSeconds, {
      positive: true,
    })
    // Validate the DERIVED ttl here too: a value that passes above but
    // fails at beat time would throw into the observability catch forever.
    this.registryTtlSeconds =
      durationToMs('registryIntervalSeconds (doubled for ttl)', registryIntervalSeconds * 2, {
        positive: true,
      }) / 1000
    this.driverId = opts.driverId ?? deps.ids.token()
    if (typeof this.driverId !== 'string' || this.driverId.length === 0) {
      throw new RangeError('driverId must be a non-empty string')
    }
    // A hanging transport call must never stall the loop: race it against
    // the clock and hand a timeout to the reconciler as a failed launch.
    this.launcher =
      opts.launchTimeoutSeconds === null
        ? deps.launcher
        : withLaunchTimeout(
            deps.launcher,
            deps.clock,
            durationToMs('launchTimeoutSeconds', opts.launchTimeoutSeconds ?? 10, {
              positive: true,
            }),
          )
  }

  /** Runs until stop(). Never rejects; tick errors are counted and backed off. */
  async run(): Promise<void> {
    if (this.everRan) {
      // One-shot by design: a restart on the same instance can revive a
      // half-stopped loop into two interleaved bodies. New loop, new
      // instance.
      throw new Error('DriverLoop.run() is one-shot — construct a new loop to restart')
    }
    this.everRan = true
    this.running = true
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve
    })
    let lastTickStartedAtMs = 0
    try {
      while (this.running) {
        let result: TickResult | null = null
        lastTickStartedAtMs = this.clock.elapsedMs()
        try {
          result = await tick(
            { store: this.store, launcher: this.launcher, ids: this.ids },
            this.tickOpts,
          )
          this.stats.ticks++
          this.stats.launched += result.launched
          this.stats.launchFailed += result.launchFailed
          this.stats.ended += result.ended
          this.stats.lastResult = result
        } catch {
          // A tick that cannot reach the store must not hot-loop; back off
          // to the idle ceiling and try again — ticking is always safe.
          this.stats.tickErrors++
        }
        this.beatRegistry() // deliberately not awaited: see its comment
        if (!this.running) break

        const empty = result !== null && result.claimed === 0 && result.swept.length === 0
        this.idleTicks = empty ? this.idleTicks + 1 : 0
        // Every sleepless pass counts toward a mandatory yield: with an
        // instant store a long drain chain is pure microtasks, and timers —
        // including whatever calls stop() — would never get a turn. This is
        // also the seam that makes runaway-loop bugs red-testable at all: a
        // starved event loop cannot even run a failing test's timeout.
        this.chainedTicks++
        if (this.chainedTicks >= 32) {
          this.chainedTicks = 0
          await this.clock.yieldTurn()
          if (!this.running) break
        }
        if (result?.backlog) continue // drain chain: no sleep

        const ceiling =
          result === null || this.idleTicks >= this.idleAfterTicks
            ? this.idleCeilingMs
            : this.busyCeilingMs
        let sleepMs = ceiling
        if (result?.nextWakeAtEpochMs != null) {
          const untilWake = result.nextWakeAtEpochMs - this.clock.nowEpochMs()
          if (untilWake <= 0) {
            // "Due" by the LOCAL clock. If the tick found work, keep
            // draining. If it found NOTHING, the local clock is ahead of
            // database time (the only way a due wake yields an empty look)
            // — poll at the ceiling instead of spinning until the database
            // catches up.
            if (!empty) continue
          } else {
            sleepMs = Math.min(untilWake, ceiling)
          }
        }
        sleepMs = Math.min(sleepMs, this.msUntilBeatDue())
        // When this park started, in elapsed time; the look it plans is `sleepMs` later.
        const parkStartedAtMs = this.clock.elapsedMs()
        if (!this.wakeRequested) {
          this.chainedTicks = 0
          this.sleepInterrupt = new AbortController()
          await this.clock.sleep(sleepMs, this.sleepInterrupt.signal)
          this.sleepInterrupt = null
        }
        if (this.wakeRequested && this.running) {
          // A wake looks again, but never sooner than the floor after the last
          // tick started, so every ping inside the interval coalesces into one
          // look, and never later than the look this park planned, which is
          // already capped at the next registry beat. Both are measured in elapsed
          // time, so a host clock step cannot stretch the wait. Only stop()
          // interrupts it.
          const nowMs = this.clock.elapsedMs()
          const remaining = Math.min(
            lastTickStartedAtMs + this.wakeFloorMs - nowMs,
            parkStartedAtMs + sleepMs - nowMs,
          )
          if (remaining > 0) {
            this.chainedTicks = 0
            await this.clock.sleep(remaining, this.floorInterrupt.signal)
          }
        }
        this.wakeRequested = false
      }
    } finally {
      this.running = false
      this.resolveStopped?.()
    }
  }

  /** Interrupt the current sleep (enqueue ping): look again, at most once per wake floor. */
  wake(): void {
    this.wakeRequested = true
    this.sleepInterrupt?.abort()
  }

  /** Finish the in-flight tick, cancel the pending sleep, resolve run(). */
  async stop(): Promise<void> {
    this.running = false
    this.sleepInterrupt?.abort()
    this.floorInterrupt.abort()
    await (this.stopped ?? Promise.resolve())
  }

  /**
   * Fire-and-forget BY DESIGN: best-effort means the loop never waits on
   * it — a beat that hangs (dead store connection) must block neither
   * driving nor shutdown, and a try/catch alone cannot make a PENDING
   * promise harmless. At most one beat is in flight; cadence is marked
   * only on success so failures retry next pass, not next interval.
   */
  private beatRegistry(): void {
    // Beat cadence runs on elapsed time, so a host clock step cannot delay a beat.
    const now = this.clock.elapsedMs()
    if (this.beatInFlight !== null) return
    if (this.lastBeatAtMs !== null && now - this.lastBeatAtMs < this.registryIntervalMs) return
    this.beatInFlight = this.store
      .driverHeartbeat(this.tickOpts.queue, this.driverId, this.registryTtlSeconds)
      .then(() => {
        this.lastBeatAtMs = now
      })
      .catch(() => {
        // observability only — never let it hurt the loop
      })
      .finally(() => {
        this.beatInFlight = null
      })
  }

  /** Park no longer than the next registry beat needs (ttl = 2x cadence:
   * sleeping past the deadline makes every idle driver read as dead).
   * Before the first CONFIRMED beat the bound is one full interval — the
   * fire-and-forget beat may still be in flight when the park is sized. */
  private msUntilBeatDue(): number {
    if (this.lastBeatAtMs === null) return this.registryIntervalMs
    const due = this.lastBeatAtMs + this.registryIntervalMs - this.clock.elapsedMs()
    return Math.max(1, due)
  }
}

/** Race launch() against the clock; a hang becomes a failed launch. */
function withLaunchTimeout(launcher: Launcher, clock: Clock, timeoutMs: number): Launcher {
  return {
    async launch(invocation) {
      const settled = new AbortController()
      const timedOut = Symbol('timeout')
      const launch = launcher.launch(invocation).finally(() => settled.abort())
      const outcome = await Promise.race([
        launch,
        clock.sleep(timeoutMs, settled.signal).then(() => timedOut as unknown),
      ])
      if (outcome === timedOut) {
        // The interrupted sleep can win a MICROTASK race against the very
        // launch that interrupted it (.finally adds resolution hops). The
        // abort flag is the truth: if the launch settled, honor it.
        if (settled.signal.aborted) return launch
        // The transport call stays pending in the background — its promise
        // is abandoned, never awaited again. The run recovers through the
        // normal lost-launch path.
        return LaunchOutcome.launchFailed()
      }
      return outcome as LaunchOutcome
    },
  }
}

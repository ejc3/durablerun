import {
  type Clock,
  durationToMs,
  type IdSource,
  LaunchOutcome,
  type Launcher,
  requirePositiveInt,
  type SchedulerStore,
} from '@durablerun/core'
import { tick, type TickOptions, type TickResult } from './tick.js'

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
  private readonly registryIntervalMs: number
  private readonly driverId: string

  private running = false
  private stopped: Promise<void> | null = null
  private resolveStopped: (() => void) | null = null
  private sleepInterrupt: AbortController | null = null
  private wakeRequested = false
  private idleTicks = 0
  private lastBeatAtMs: number | null = null
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
    this.tickOpts = {
      queue: opts.queue,
      claimLimit: opts.claimLimit,
      sweepLimit: opts.sweepLimit,
      leaseSeconds: opts.leaseSeconds,
    }
    this.busyCeilingMs = requirePositiveInt('busyCeilingMs', opts.busyCeilingMs ?? 250)
    this.idleCeilingMs = requirePositiveInt('idleCeilingMs', opts.idleCeilingMs ?? 5000)
    this.idleAfterTicks = requirePositiveInt('idleAfterTicks', opts.idleAfterTicks ?? 10)
    this.registryIntervalMs = durationToMs(
      'registryIntervalSeconds',
      opts.registryIntervalSeconds ?? 15,
      { positive: true },
    )
    this.driverId = opts.driverId ?? deps.ids.token()
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
    if (this.running) throw new Error('DriverLoop.run() called twice')
    this.running = true
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve
    })
    try {
      while (this.running) {
        let result: TickResult | null = null
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
        await this.beatRegistry()
        if (!this.running) break

        const empty = result !== null && result.claimed === 0 && result.swept.length === 0
        this.idleTicks = empty ? this.idleTicks + 1 : 0
        if (result?.backlog) continue // drain chain: no sleep

        const ceiling =
          result === null || this.idleTicks >= this.idleAfterTicks
            ? this.idleCeilingMs
            : this.busyCeilingMs
        let sleepMs = ceiling
        if (result?.nextWakeAtEpochMs != null) {
          const untilWake = result.nextWakeAtEpochMs - this.clock.nowEpochMs()
          if (untilWake <= 0) continue // due now: look again immediately
          sleepMs = Math.min(untilWake, ceiling)
        }
        if (this.wakeRequested) {
          this.wakeRequested = false
          continue
        }
        this.sleepInterrupt = new AbortController()
        await this.clock.sleep(sleepMs, this.sleepInterrupt.signal)
        this.sleepInterrupt = null
        this.wakeRequested = false
      }
    } finally {
      this.running = false
      this.resolveStopped?.()
    }
  }

  /** Interrupt the current sleep (enqueue ping): tick again NOW. */
  wake(): void {
    this.wakeRequested = true
    this.sleepInterrupt?.abort()
  }

  /** Finish the in-flight tick, cancel the pending sleep, resolve run(). */
  async stop(): Promise<void> {
    this.running = false
    this.sleepInterrupt?.abort()
    await (this.stopped ?? Promise.resolve())
  }

  private async beatRegistry(): Promise<void> {
    const now = this.clock.nowEpochMs()
    if (this.lastBeatAtMs !== null && now - this.lastBeatAtMs < this.registryIntervalMs) return
    this.lastBeatAtMs = now
    try {
      // ttl = 2x cadence: one missed beat does not read as death.
      await this.store.driverHeartbeat(
        this.tickOpts.queue,
        this.driverId,
        (this.registryIntervalMs * 2) / 1000,
      )
    } catch {
      // observability only — never let it hurt the loop
    }
  }
}

/** Race launch() against the clock; a hang becomes a failed launch. */
function withLaunchTimeout(launcher: Launcher, clock: Clock, timeoutMs: number): Launcher {
  return {
    async launch(invocation) {
      const settled = new AbortController()
      const timedOut = Symbol('timeout')
      const outcome = await Promise.race([
        launcher.launch(invocation).finally(() => settled.abort()),
        clock.sleep(timeoutMs, settled.signal).then(() => timedOut as unknown),
      ])
      if (outcome === timedOut) {
        // The transport call stays pending in the background — its promise
        // is abandoned, never awaited again. The run recovers through the
        // normal lost-launch path.
        return LaunchOutcome.launchFailed(
          new Error(`launch timed out after ${timeoutMs}ms (transport hang)`),
        )
      }
      return outcome as LaunchOutcome
    },
  }
}

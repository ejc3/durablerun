import {
  type Checkpoint,
  type ClaimedRun,
  EventTimeoutError,
  FatalTaskError,
  LeaseLostError,
  type SchedulerStore,
  SuspendSignal,
  userDurationToMs,
  userEpochMs,
  UserName,
} from '@durablerun/core'

/**
 * An engine-namespace replay key ('$'-prefixed, so no validated user name
 * can collide with it). Only the static constructors exist: a context
 * method structurally cannot build a durable key from a raw string —
 * every user-supplied part enters through UserName.parse, which is also
 * where the reserved-charset rule lives, once.
 */
class EngineKey {
  private constructor(readonly value: string) {}
  static readonly sleep = new EngineKey('$sleep')
  static readonly sleepUntil = new EngineKey('$sleep-until')
  static awaitEvent(name: UserName): EngineKey {
    return new EngineKey(`$await:${name.value}`)
  }
}

/**
 * The durable task context (DESIGN.md §3.2). A task function runs many
 * times — every retry, every wake after a sleep — but each STEP runs once:
 * `step(name, fn)` returns the checkpointed result when this step already
 * committed on any earlier pass, and executes-then-checkpoints otherwise.
 * The checkpoint write is lease-fenced by the store, so a run that lost its
 * lease cannot commit progress; the resulting LeaseLostError aborts the
 * whole pass quietly (another claim owns the run now).
 */
export interface TaskContext {
  /**
   * Durable memoization. fn's RESULT commits at most once — but fn itself
   * runs AT LEAST once: a crash between executing and committing means the
   * next attempt re-executes it. External side effects (emails, payments)
   * need their own idempotency key. The returned value is the serialized
   * canonical form on every pass.
   */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>
  /**
   * Durable sleep. Suspends the run now and resumes AFTER the duration —
   * the awaited expression never returns on the suspending pass (it
   * throws the internal suspend signal), and replays as a no-op once the
   * wake has passed.
   */
  sleepFor(seconds: number): Promise<void>
  /** Durable absolute-time sleep (the one sanctioned user absolute). */
  sleepUntil(epochMs: number): Promise<void>
  /**
   * Suspend until the named event is emitted (or the timeout passes —
   * then EventTimeoutError). Resolves to the emitted payload JSON; the
   * consumption is memoized like any step, so replays and later sleeps
   * never re-see a stale wake.
   */
  awaitEvent(name: string, opts?: { timeoutSeconds?: number }): Promise<string>
  /** First write wins: a second emit of the same name changes nothing. */
  emitEvent(name: string, payloadJson: string): Promise<void>
  /** This attempt's user-visible ordinal (infrastructure retries excluded). */
  readonly attempt: number
  readonly taskName: string
}

/** One execution pass over a claimed run. */
export class ReplayContext implements TaskContext {
  readonly attempt: number
  readonly taskName: string
  private readonly seen = new Map<string, unknown>()
  private readonly nameUses = new Map<string, number>()
  private inStep = false
  /**
   * The claim's carried wake, held as the ONLY mutable reference to it —
   * takeWake consumes it, and nothing else reads this.run.wake. Consume-once
   * is then structural, not a discipline: a taken wake is unreadable, so a
   * second await of the same event name cannot re-see it (the stale-wake
   * re-consumption that was the worst confirmed bug of the events review).
   */
  private pendingWake: ClaimedRun['wake']

  constructor(
    private readonly store: SchedulerStore,
    private readonly queue: string,
    private readonly run: ClaimedRun,
    checkpoints: Checkpoint[],
    private readonly leaseLost?: AbortSignal,
  ) {
    this.attempt = run.attempt - run.infraRetries
    this.taskName = run.taskName
    this.pendingWake = run.wake
    for (const cp of checkpoints) {
      this.seen.set(cp.checkpointName, JSON.parse(cp.stateJson))
    }
  }

  /**
   * Consume the carried wake IFF it was registered by the await with this
   * STEP key; unreadable afterward. Matching by step (unique per await),
   * not by event name (shared across awaits of the same event), is what
   * keeps one await from consuming another await's wake.
   */
  private takeWake(stepKey: string): ClaimedRun['wake'] {
    if (this.pendingWake?.step !== stepKey) return undefined
    const wake = this.pendingWake
    this.pendingWake = undefined
    return wake
  }

  /**
   * Derives the storage name for this call site: first use of a name is the
   * name itself, later uses append a counter (`poll`, `poll#2`, `poll#3`) —
   * loops over the same step name get distinct checkpoints, and replay
   * matches by call ORDER within a name, which is stable as long as the
   * task's step sequence is deterministic (the contract user code signs).
   */
  private storageName(name: UserName | EngineKey): string {
    const raw = name.value
    const use = (this.nameUses.get(raw) ?? 0) + 1
    this.nameUses.set(raw, use)
    return use === 1 ? raw : `${raw}#${use}`
  }

  /**
   * The single gate every durable primitive (step, sleep, await) passes
   * before it allocates a replay key. It rejects nesting ANY durable op
   * inside a step: an inner durable call advances the repeat counters a
   * replaying pass (which skips the memoized step body) never sees, so a
   * later same-named op replays the wrong checkpoint or consumes the wrong
   * wake. Reentrancy-proof by construction, not by remembering to check.
   */
  private enterDurableOp(what: string): void {
    // The pump observed the lease gone: stop the handler at the next
    // context call — the fences protect STATE regardless; this stops a
    // zombie from burning further side effects and worker time.
    if (this.leaseLost?.aborted) {
      throw new LeaseLostError(`lease lost during pass (run ${this.run.runId})`)
    }
    if (this.inStep) {
      throw new FatalTaskError(
        `${what} called inside a step — durable operations cannot nest inside a step`,
      )
    }
  }

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const parsed = UserName.parse('step name', name)
    this.enterDurableOp(`ctx.step('${name}')`)
    const key = this.storageName(parsed)
    if (this.seen.has(key)) {
      return this.seen.get(key) as T
    }
    // Execute, then commit. A throwing step checkpoints NOTHING — the next
    // attempt re-executes it (retries are the failure story, not replay).
    this.inStep = true
    let raw: unknown
    try {
      raw = (await fn()) ?? null
    } finally {
      this.inStep = false
    }
    const stateJson = JSON.stringify(raw)
    // ONE representation: the caller gets the serialize-then-parse
    // CANONICAL value on the executing pass too, so NaN, Dates, dropped
    // undefined fields, and -0 read identically on every pass of every
    // schedule (there is no second path for divergence to live in).
    const result = JSON.parse(stateJson) as T
    await this.store.setCheckpoint(
      this.queue,
      this.run.taskId,
      this.run.runId,
      this.run.claimToken,
      key,
      stateJson,
      this.run.leaseSeconds,
    )
    this.seen.set(key, result)
    return result
  }

  async sleepFor(seconds: number): Promise<void> {
    this.enterDurableOp('ctx.sleepFor')
    // Validate HERE, before any suspend signal exists: an invalid duration
    // is a permanent user error, and validating later (inside the park)
    // would loop the deterministic bad call through lease recovery.
    userDurationToMs('sleepFor seconds', seconds)
    await this.suspendPoint(EngineKey.sleep, { inSeconds: seconds })
  }

  async sleepUntil(epochMs: number): Promise<void> {
    this.enterDurableOp('ctx.sleepUntil')
    userEpochMs('sleepUntil epochMs', epochMs)
    await this.suspendPoint(EngineKey.sleepUntil, { atEpochMs: epochMs })
  }

  async emitEvent(name: string, payloadJson: string): Promise<void> {
    // Validated for symmetry with awaitEvent: a reserved-charset event
    // name could never be awaited, so emitting one is a permanent bug,
    // not a payload nobody can receive.
    const parsed = UserName.parse('event name', name)
    await this.store.emitEvent(this.queue, parsed.value, payloadJson)
  }

  async awaitEvent(name: string, opts?: { timeoutSeconds?: number }): Promise<string> {
    const parsed = UserName.parse('event name', name)
    this.enterDurableOp('ctx.awaitEvent')
    if (opts?.timeoutSeconds !== undefined) {
      userDurationToMs('awaitEvent timeoutSeconds', opts.timeoutSeconds, { positive: true })
    }
    const key = this.storageName(EngineKey.awaitEvent(parsed))
    if (this.seen.has(key)) {
      // A memo already covers THIS await (matched by its step key) — retire
      // its carried wake so it cannot be re-read; a wake for a different
      // await (same event name, different step) is left untouched.
      this.takeWake(key)
      const memo = this.seen.get(key) as { timedOut?: boolean; payloadJson?: string }
      if (memo.timedOut) throw new EventTimeoutError(name)
      return memo.payloadJson as string
    }
    // A wake delivered with this claim resolves the await, consumed once:
    // the run row's wake fields persist after delivery, so matching by the
    // unique step key (not the shared event name) keeps a later same-name
    // await from stealing this one's wake.
    const wake = this.takeWake(key)
    if (wake) {
      const memo = 'payloadJson' in wake ? { payloadJson: wake.payloadJson } : { timedOut: true }
      await this.commitMarker(key, JSON.stringify(memo))
      if (memo.timedOut) throw new EventTimeoutError(name)
      return memo.payloadJson as string
    }
    const outcome = await this.store.awaitEvent(
      this.queue,
      this.run.taskId,
      this.run.runId,
      this.run.claimToken,
      key,
      name,
      opts?.timeoutSeconds ?? null,
    )
    if (outcome.emitted) {
      await this.commitMarker(key, JSON.stringify({ payloadJson: outcome.payloadJson }))
      return outcome.payloadJson
    }
    // The store batch ALREADY parked the run: signal without a wake so the
    // runtime performs no second suspension.
    throw new SuspendSignal('await-event')
  }

  /** Lease-fenced marker write shared by the await memoization. */
  private async commitMarker(key: string, stateJson: string): Promise<void> {
    await this.store.setCheckpoint(
      this.queue,
      this.run.taskId,
      this.run.runId,
      this.run.claimToken,
      key,
      stateJson,
      this.run.leaseSeconds,
    )
    this.seen.set(key, JSON.parse(stateJson))
  }

  /**
   * A durable suspension point is a checkpoint whose EXISTENCE means "the
   * wake already happened" — which is only true if the marker and the park
   * are ONE transition. The suspending pass therefore writes nothing here:
   * it throws the signal CARRYING the marker, and the worker runtime lands
   * both atomically via store.suspendRun. A later claim can only happen
   * once the run is due again, so on replay, existence alone proves the
   * sleep is over. No clock is consulted anywhere.
   */
  private async suspendPoint(
    kind: EngineKey,
    wake: { inSeconds: number } | { atEpochMs: number },
  ): Promise<void> {
    const key = this.storageName(kind)
    if (this.seen.has(key)) return // the wake already happened: continue
    throw new SuspendSignal('sleep', wake, { key, stateJson: JSON.stringify(wake) })
  }
}

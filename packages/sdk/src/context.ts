import {
  type Checkpoint,
  type ClaimedRun,
  requireEpochMs,
  type SchedulerStore,
  SuspendSignal,
} from '@durablerun/core'

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
  /** Durable memoization: fn runs at most once per step name, ever. */
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

  constructor(
    private readonly store: SchedulerStore,
    private readonly queue: string,
    private readonly run: ClaimedRun,
    checkpoints: Checkpoint[],
  ) {
    this.attempt = run.attempt - run.infraRetries
    this.taskName = run.taskName
    for (const cp of checkpoints) {
      this.seen.set(cp.checkpointName, JSON.parse(cp.stateJson))
    }
  }

  /**
   * Derives the storage name for this call site: first use of a name is the
   * name itself, later uses append a counter (`poll`, `poll#2`, `poll#3`) —
   * loops over the same step name get distinct checkpoints, and replay
   * matches by call ORDER within a name, which is stable as long as the
   * task's step sequence is deterministic (the contract user code signs).
   */
  private storageName(name: string): string {
    const use = (this.nameUses.get(name) ?? 0) + 1
    this.nameUses.set(name, use)
    return use === 1 ? name : `${name}#${use}`
  }

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const key = this.storageName(name)
    if (this.seen.has(key)) {
      return this.seen.get(key) as T
    }
    // Execute, then commit. A throwing step checkpoints NOTHING — the next
    // attempt re-executes it (retries are the failure story, not replay).
    const result = await fn()
    const stateJson = JSON.stringify(result ?? null)
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
    await this.suspendPoint(`$sleep`, { inSeconds: seconds })
  }

  async sleepUntil(epochMs: number): Promise<void> {
    requireEpochMs('sleepUntil epochMs', epochMs)
    await this.suspendPoint(`$sleep-until`, { atEpochMs: epochMs })
  }

  /**
   * A durable suspension point is a checkpoint whose EXISTENCE means "the
   * wake already happened": the suspending pass writes it and throws; the
   * store's reschedule parks the run until the wake; and a later claim can
   * only happen once the run is due again — so on replay, existence alone
   * proves the sleep is over. No clock is consulted anywhere.
   */
  private async suspendPoint(
    kind: string,
    wake: { inSeconds: number } | { atEpochMs: number },
  ): Promise<void> {
    const key = this.storageName(kind)
    if (this.seen.has(key)) return // the wake already happened: continue
    await this.store.setCheckpoint(
      this.queue,
      this.run.taskId,
      this.run.runId,
      this.run.claimToken,
      key,
      JSON.stringify(wake),
      this.run.leaseSeconds,
    )
    throw new SuspendSignal('sleep', wake)
  }
}

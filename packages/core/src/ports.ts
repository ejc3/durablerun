import type { LaunchOutcome } from './launch.js'
import type {
  Checkpoint,
  CheckpointWrite,
  ClaimedRun,
  FailOutcome,
  FailedRollback,
  LaunchIdentity,
  LeaseState,
  SpawnOptions,
  SpawnResult,
  SweptRun,
  TaskResult,
  WakeSpec,
} from './types.js'

/**
 * The five ports (DESIGN.md §3.9). The scheduler lease is the only source of
 * truth for execution rights; every other signal is advisory and may only
 * accelerate what the lease timer would do anyway (`expireLeaseNow`).
 *
 * Implementations route ALL I/O through a single injected SqlExecutor and
 * compute ALL absolute timestamps in SQL. Every method is one fenced,
 * idempotent batch (or dialect-equivalent transaction).
 */
export interface SchedulerStore {
  spawn(
    queue: string,
    taskName: string,
    paramsJson: string,
    opts?: SpawnOptions,
  ): Promise<SpawnResult>

  /**
   * §3.1 step 2 — increments claim_gen; follow-on statements fence on
   * claimToken. Options object because two adjacent numbers in spec-reversed
   * order compiled silently with swapped values (codex finding).
   */
  claim(
    queue: string,
    claimToken: string,
    opts: { leaseSeconds: number; limit: number },
  ): Promise<ClaimedRun[]>

  /**
   * §3.2 — per-claim generation CAS; re-extends the lease. Returns the full
   * run⋈task payload (the launch carries only ids, and the worker must not
   * call claim() to learn its own run). Null = duplicate delivery, superseded
   * claim, or swept lease: exit immediately.
   */
  activate(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
  ): Promise<ClaimedRun | null>

  /**
   * The claimed run's task name, read before activation so a worker can decide to
   * defer a task it has no handler for without latching the first start. An
   * unfenced read of an immutable value, answered only while the run is still
   * running under this claim token and generation and not yet activated; null
   * otherwise, which the worker treats as superseded.
   */
  claimedTaskName(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
  ): Promise<string | null>

  /**
   * §3.2 rolling-deploy deferral, decided before activation: a worker build with
   * no handler for the claimed task parks the claimed run `inSeconds` from
   * database time. Fenced on the claim receipt (running under this token and
   * generation, not yet activated), it refuses the corrupt or inadmissible claims
   * activation refuses and, like every suspension, requires an eligible task. It
   * consumes no attempt or relaunch, keeps the run's wake fields, and never
   * latches the first start. A refusal throws RunCancelledError when the task's
   * cancellation ended the run, and LeaseLostError otherwise.
   */
  deferLaunch(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
    inSeconds: number,
  ): Promise<void>

  /**
   * A refused extension reports `held: false` and names why, like a refused
   * write: `cancelled` when the task's cancellation ended the run, and
   * `lease-lost` otherwise.
   */
  heartbeat(
    queue: string,
    runId: string,
    claimToken: string,
    extendLeaseSeconds: number,
  ): Promise<LeaseState>

  /**
   * Sleep / defer / attempt-neutral chain ({ inSeconds: 0 }). The absolute
   * form exists solely for ctx.sleepUntil — §3.4 rule 3's one sanctioned
   * user-supplied absolute; the store writes it verbatim, never converting
   * via an instance clock.
   *
   * A carried event wake is consumed: the worker processed it, so later timer
   * wakes must not replay the event. A launch no handler can run defers through
   * `deferLaunch` instead, before activation, and keeps its wake.
   */
  reschedule(queue: string, runId: string, claimToken: string, wake: WakeSpec): Promise<void>

  complete(queue: string, runId: string, claimToken: string, resultJson: string): Promise<void>

  /**
   * Suspend WITH a durable marker, atomically: the park and the checkpoint
   * commit in one transition or neither does. A marker whose park failed
   * would lie ("the wake already happened") and let an infrastructure
   * successor skip the whole sleep. Used by the SDK's sleep/await points;
   * markerless suspensions use reschedule.
   */
  suspendRun(
    queue: string,
    runId: string,
    claimToken: string,
    wake: WakeSpec,
    checkpoint: CheckpointWrite,
  ): Promise<void>

  /**
   * Retry policy decided in core; the store applies the fenced transition.
   *
   * A failure with no retry left is the task's terminal decision. When a registered
   * step of the task started and is not rolled back, the same batch enters the
   * rolling-back phase instead of ending the task: it writes the phase marker and
   * places a rollback pass (DESIGN.md §3.10). Inside the phase a failure with no retry
   * ends the task: that is how a pass that ran every rollback finishes the saga, and
   * the rollback outcome is derived from what ran. A failed rollback is `failRollback`.
   * A retry asked for here in the phase is capped like any other, which halts the saga.
   */
  fail(
    queue: string,
    runId: string,
    claimToken: string,
    failureJson: string,
    retry: { delaySeconds: number } | null,
  ): Promise<FailOutcome>

  /**
   * A rollback of a task that is rolling back failed (DESIGN.md §3.10, specs/Sagas.tla
   * RollbackRetry and RollbackHalts). `rollback` is the step and the failure of this
   * attempt. The store names the rollback's attempt record and counts the attempt: one
   * past the last record it can read, one when it can read none, and never past the
   * largest safe integer. A caller chooses neither the name nor the count. An argument of
   * another shape is refused before anything is read or sent. The port's one check answers
   * it first, as it answers any string the port requires that was left out: a caller of an
   * older build, which hands over the attempt record as `{ key, stateJson }`, is told that
   * `rollback.stepKey` was left out. That refusal is a TypeError by its class, and the
   * entry's own reader refuses the same shapes with a TypeError for a caller that reaches
   * the entry some other way. No hosted route calls this port.
   * The record commits with the failure, so a failed attempt is counted or the run did
   * not fail. With `retry` another pass follows, and the user attempt budget does not
   * cap it. With none the saga halts, and the task ends `failed` with `failureJson`,
   * which the caller passes as the failure that began the saga. Refused outside the
   * phase. It is its own method and batch label ('fail-rollback'), not an option of
   * `fail`, so nothing that forwards `fail` can drop the record.
   */
  failRollback(
    queue: string,
    runId: string,
    claimToken: string,
    failureJson: string,
    retry: { delaySeconds: number } | null,
    rollback: FailedRollback,
  ): Promise<FailOutcome>

  /** §3.1 steps 0–1: cancellation policies + expired leases, classified by activation state. */
  sweep(queue: string, limit: number): Promise<SweptRun[]>

  /** The single advisory write (§3.9). True if it expired a live lease. */
  expireLeaseNow(queue: string, runId: string, claimToken: string): Promise<boolean>

  getCheckpoints(queue: string, taskId: string, attempt: number): Promise<Checkpoint[]>

  /** Lease-fenced in both placements (§3.4 rule 5). */
  setCheckpoint(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    checkpointName: string,
    stateJson: string,
    extendLeaseSeconds: number,
  ): Promise<void>

  /** First write wins. Refuses a reserved name, one that starts with `$`, with RangeError. */
  emitEvent(queue: string, eventName: string, payloadJson: string): Promise<void>

  /**
   * Registers the wait or returns the already-emitted payload (§3.4 rule 2).
   * Refuses a reserved name, one that starts with `$`, with RangeError.
   */
  awaitEvent(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    eventName: string,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false }>

  /**
   * Await a child task's completion event (DESIGN.md §3.2, specs/ChildTasks.tla).
   * It is `awaitEvent` for the reserved name built from `childTaskId`, which no
   * caller can pass to `awaitEvent` itself. The payload is the child's first
   * outcome (`decodeTaskOutcome`). A child in another queue, or no such task, is
   * refused with ChildAwaitRefusedError and registers nothing: events are keyed
   * by queue, so only a child in this queue can wake this run.
   */
  awaitTaskDone(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    childTaskId: string,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false }>

  /**
   * The task's observable outcome, or null when no such task exists. Refuses a
   * row whose outcome contradicts its state with RangeError (DESIGN.md §3.4
   * task-result contract).
   */
  getTaskResult(queue: string, taskId: string): Promise<TaskResult | null>

  /** min(available_at, claim_expires_at, cancellation deadlines) — for re-arm. */
  nextWakeAtEpochMs(queue: string): Promise<number | null>

  /**
   * Observability only: upsert this driver's liveness row (nothing in the
   * protocol reads it). Best-effort — callers tolerate failure.
   */
  driverHeartbeat(queue: string, driverId: string, ttlSeconds: number): Promise<void>

  cancelTask(queue: string, taskId: string): Promise<boolean>

  /**
   * Absurd's retry_task: revive a FAILED task in place with a new pending run at
   * the next ordinal, due now, that carries the top run's parked wake. A top run no
   * counter recorded (an infrastructure or relaunch cap) is charged as a user
   * attempt, the budget grows by one, and the task's failure reason is cleared.
   * Null, writing nothing, when the task is not in this queue, is not failed, has
   * no runs or a live run, owns a run in another queue, or its failure is corrupt:
   * no reason, a completed payload, or counters out of range or out of accounting.
   */
  retryTask(queue: string, taskId: string): Promise<{ runId: string; attempt: number } | null>
}

/** Test/simulation-only surface; never used by engine actors. */
export interface StoreAdmin {
  migrate(): Promise<void>
  /** Canonically decoded recorded version; a genuinely fresh database also reports zero. */
  schemaVersion(): Promise<number>
  /** Engine time override (shard-meta fake_now); null restores real time. */
  setFakeNowEpochMs(epochMs: number | null): Promise<void>
  nowEpochMs(): Promise<number>
}

export interface LaunchInvocation extends LaunchIdentity {
  /** Stands in for the shard id until multi-shard lands (§3.7). */
  queue: string
  attempt: number
  claimGen: number
  /**
   * The lease deadline stamped at claim — lets the worker plan voluntary
   * chaining without an extra round trip (activation re-extends it).
   */
  deadlineHintEpochMs: number
}

/** What a caller may hand a launcher beside the invocation (§3.9 port 2). */
export interface LaunchOptions {
  /**
   * Fires once the caller has stopped waiting for this launch, which for the resident
   * driver is when its launch deadline passes. Nothing the launcher answers after that is
   * read, and the caller reconciles the launch as failed, exactly as it does for a call
   * that never settles. A launcher may use the signal to let go of what the call holds (a
   * request in flight, a socket), and may ignore it. The signal says nothing about the
   * run: the worker may already hold the launch, so a launcher never reads it as evidence
   * that the run did not start, and never as a reason to stop a worker.
   */
  signal?: AbortSignal
}

/**
 * Execution transport (§3.9 port 2). Fire-and-forget may silently lose
 * launches. Outcomes are constructed via LaunchOutcome's static factories
 * (core/launch.ts) and consumed ONLY via LaunchOutcome.reconcile — callers
 * have no other affordance, by design. `options` is optional on both sides: a
 * caller may pass none, and a launcher may declare the invocation alone.
 */
export interface Launcher {
  launch(invocation: LaunchInvocation, options?: LaunchOptions): Promise<LaunchOutcome>
}

/**
 * Inline launcher ending. The claim token is mandatory because runId alone
 * survives across claims. Tokenless feed reconciliation needs a future atomic
 * heartbeat-cutoff store operation and is not representable at this boundary.
 */
export interface Ending extends LaunchIdentity {
  kind: 'completed' | 'failed' | 'crashed' | 'timeout' | 'unknown'
}

/** Advisory accelerators (§3.9 port 5); every method is fire-and-forget. */
export interface WakeSignals {
  ping(queue: string): void
  alarmAt?(queue: string, epochMs: number): void
}

import type {
  Checkpoint,
  ClaimedRun,
  LeaseState,
  SpawnOptions,
  SpawnResult,
  SweptRun,
  TaskResult,
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

  /** §3.1 step 2 — increments claim_gen; follow-on statements fence on claimToken. */
  claim(
    queue: string,
    claimToken: string,
    leaseSeconds: number,
    limit: number,
  ): Promise<ClaimedRun[]>

  /** §3.2 — per-claim generation CAS; re-extends the lease. False = exit now. */
  activate(queue: string, runId: string, claimToken: string, claimGen: number): Promise<boolean>

  /** Zero-rows result surfaces as `held: false` — the AB002 signal. */
  heartbeat(
    queue: string,
    runId: string,
    claimToken: string,
    extendSeconds: number,
  ): Promise<LeaseState>

  /** Sleep / defer / attempt-neutral chain (wakeInSeconds = 0). */
  reschedule(queue: string, runId: string, claimToken: string, wakeInSeconds: number): Promise<void>

  complete(queue: string, runId: string, claimToken: string, resultJson: string): Promise<void>

  /** Retry policy decided in core; the store applies the fenced transition. */
  fail(
    queue: string,
    runId: string,
    claimToken: string,
    failureJson: string,
    retry: { delaySeconds: number } | null,
  ): Promise<void>

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

  emitEvent(queue: string, eventName: string, payloadJson: string): Promise<void>

  /** Registers the wait or returns the already-emitted payload (§3.4 rule 2). */
  awaitEvent(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    eventName: string,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false }>

  getTaskResult(queue: string, taskId: string): Promise<TaskResult | null>

  /** min(available_at, claim_expires_at, cancellation deadlines) — for re-arm. */
  nextWakeAtEpochMs(queue: string): Promise<number | null>

  cancelTask(queue: string, taskId: string): Promise<boolean>
}

/** Test/simulation-only surface; never used by engine actors. */
export interface StoreAdmin {
  migrate(): Promise<void>
  /** Engine time override (shard-meta fake_now); null restores real time. */
  setFakeNowEpochMs(epochMs: number | null): Promise<void>
  nowEpochMs(): Promise<number>
}

export interface LaunchInvocation {
  queue: string
  runId: string
  attempt: number
  claimToken: string
  claimGen: number
}

export type LaunchOutcome =
  | { kind: 'accepted' }
  | { kind: 'ended'; ending: Ending }
  | { kind: 'launch-failed'; error: unknown }

/** Execution transport (§3.9 port 2). Fire-and-forget may silently lose launches. */
export interface Launcher {
  launch(invocation: LaunchInvocation): Promise<LaunchOutcome>
}

export interface Ending {
  runId: string
  claimToken?: string
  kind: 'completed' | 'failed' | 'crashed' | 'timeout' | 'unknown'
}

/** Advisory accelerators (§3.9 port 5); every method is fire-and-forget. */
export interface WakeSignals {
  ping(queue: string): void
  alarmAt?(queue: string, epochMs: number): void
}

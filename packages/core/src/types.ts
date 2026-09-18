/**
 * Engine data model, ported from Absurd's t_/r_/c_/e_/w_ tables
 * (DESIGN.md §1.2, §3.4) with the additions from adversarial review:
 * per-claim generations, activation state, and split retry accounting.
 */

/** Canonical runtime partitions for every task/run state consumer. */
export const LIVE_STATES = Object.freeze(['pending', 'running', 'sleeping'] as const)
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled'] as const)

export type LiveState = (typeof LIVE_STATES)[number]
export type TerminalState = (typeof TERMINAL_STATES)[number]
export type TaskState = LiveState | TerminalState

const LIVE_STATE_SET: ReadonlySet<string> = new Set(LIVE_STATES)
const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(TERMINAL_STATES)

export function isLiveState(value: unknown): value is LiveState {
  return typeof value === 'string' && LIVE_STATE_SET.has(value)
}

export function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === 'string' && TERMINAL_STATE_SET.has(value)
}

export type RunState = TaskState

/** Serialized as JSON in the `retry_strategy` column, same shape as Absurd. */
export type RetryStrategy =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed'; readonly baseSeconds: number }
  | {
      readonly kind: 'exponential'
      readonly baseSeconds: number
      readonly factor: number
      readonly maxSeconds: number
    }

declare class NormalizedRetryStrategyIdentity {
  private readonly normalizedRetryStrategyIdentity: true
}

/**
 * Exact, frozen, millisecond-canonical retry data produced only by
 * normalizeRetryStrategy. Durable decoders and the scheduler store expose
 * this type so retry math cannot consume an unchecked JSON cast.
 */
export type NormalizedRetryStrategy = RetryStrategy & NormalizedRetryStrategyIdentity

/** Absurd's cancellation policy jsonb: both fields optional, in seconds. */
export interface CancellationPolicy {
  /** Cancel if never started within N seconds of enqueue. */
  maxDelaySeconds?: number
  /** Cancel if still alive N seconds after first start. */
  maxDurationSeconds?: number
}

export interface SpawnOptions {
  /** The caller's key. One that starts with `$` is refused: that namespace is the engine's. */
  idempotencyKey?: string
  /**
   * The engine's key for a child task: the parent that spawns it, and the replay key
   * of the spawn's call site. The store builds the key from these (`childSpawnKey`), in
   * the reserved namespace no caller's `idempotencyKey` can reach, so a replayed spawn
   * finds its own child and nobody else can put a task there first. It cannot be given
   * together with `idempotencyKey`. The hosted enqueue route never sets it.
   */
  childOf?: { readonly parentTaskId: string; readonly replayKey: string }
  retryStrategy?: RetryStrategy
  maxAttempts?: number
  cancellation?: CancellationPolicy
  headers?: Record<string, string>
  /**
   * Deferred start, relative — engine time computes the absolute (§3.4
   * rule 3: clients pass durations; instance clocks never enter the engine).
   */
  startDelaySeconds?: number
}

export interface SpawnResult {
  taskId: string
  /**
   * The run this call created, or — when it lost — the newest run the winning
   * task already had.
   *
   * Null is a real answer, not an error: a task that already exists may have
   * no run at all, and there is then nothing honest to report. It is typed
   * nullable so callers have to decide what to do about that; the previous
   * version returned the id it had minted and never inserted, so a caller
   * polling that id found nothing, forever, with no way to tell.
   */
  runId: string | null
  /** False when the idempotency key matched an existing task. */
  created: boolean
}

/**
 * A run claimed by a tick and handed to a worker. `claimToken` and `claimGen`
 * fence every subsequent write (DESIGN.md §3.2): activation is a CAS on
 * `activated_gen < claim_gen`, never a one-shot flag.
 */
export interface LaunchIdentity {
  runId: string
  claimToken: string
}

export interface ClaimedRun extends LaunchIdentity {
  taskId: string
  taskName: string
  /**
   * Fence-monotonic run ordinal for this task — counts EVERY successor run
   * (user retries and infra `$ClaimTimeout` successors alike), because the
   * data-plane fence key is (attempt, claim_gen). The user-failure ordinal
   * for retry policy is `attempt - infraRetries`.
   */
  attempt: number
  /** Task-lifetime count of infra (`$ClaimTimeout`) successors. */
  infraRetries: number
  claimGen: number
  /** Lease deadline as stamped by the claim — the worker's chaining budget. */
  claimExpiresAtEpochMs: number
  /** The lease length this claim was granted (worker heartbeat cadence). */
  leaseSeconds: number
  paramsJson: string
  retryStrategy: NormalizedRetryStrategy
  maxAttempts: number
  headers: Record<string, string>
  /** Present when this claim is an event or event-timeout wake. */
  wake?: EventWake
}

/**
 * Discriminated so impossible states are unrepresentable: a wake either
 * delivered a payload or timed out — never both, never neither (the SDK
 * surfaces the timeout branch as EventTimeoutError). `step` is the replay
 * key of the exact await that registered the wait, so the SDK matches a
 * delivered wake to the right await instance (not by the non-unique event
 * name).
 */
export type EventWake =
  | { event: string; step: string; payloadJson: string }
  | { event: string; step: string; timedOut: true }

/** Where a suspended run wakes: relative engine time, or the sanctioned user absolute. */
export type WakeSpec = { inSeconds: number } | { atEpochMs: number }

/** A durable marker written in the same transition as a suspension. */
export interface CheckpointWrite {
  key: string
  stateJson: string
}

export interface Checkpoint {
  checkpointName: string
  stateJson: string
  ownerRunId: string
  ownerAttempt: number
}

/** Result of the sweep's per-run classification (DESIGN.md §3.1 step 1). */
export type SweptRun =
  | { kind: 'lost-launch'; runId: string; taskId: string; relaunchCount: number }
  | { kind: 'claim-timeout'; runId: string; taskId: string; successorRunId: string }
  | { kind: 'relaunch-cap-exhausted'; runId: string; taskId: string }
  | { kind: 'infra-cap-exhausted'; runId: string; taskId: string }
  | { kind: 'cancelled'; runId: string | null; taskId: string }

/**
 * A heartbeat's answer. A held lease carries the engine-clock milliseconds it
 * has left. A refused extension names why, from its run's state read after the
 * refusal: `cancelled` when the task's cancellation ended the run (Absurd
 * AB001), and `lease-lost` otherwise, including when that read fails (AB002).
 */
export type LeaseState =
  | { held: true; remainingMs: number }
  | { held: false; remainingMs: 0; reason: LeaseEnd }

/** Why a worker's fence was refused: the task's cancellation ended the run, or the lease is lost. */
export type LeaseEnd = 'cancelled' | 'lease-lost'

/**
 * A task's observable outcome. A completed task always carries its payload, a
 * failed or cancelled task always carries its reason, and no other state
 * carries either. `decodeTaskResult` refuses a row that contradicts this.
 */
export interface TaskResult {
  state: TaskState
  completedPayloadJson?: string
  failureReasonJson?: string
}

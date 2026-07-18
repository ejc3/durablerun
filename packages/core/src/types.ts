/**
 * Engine data model, ported from Absurd's t_/r_/c_/e_/w_ tables
 * (DESIGN.md §1.2, §3.4) with the additions from adversarial review:
 * per-claim generations, activation state, and split retry accounting.
 */

export type TaskState = 'pending' | 'running' | 'sleeping' | 'completed' | 'failed' | 'cancelled'

export type RunState = TaskState

/** Serialized as JSON in the `retry_strategy` column, same shape as Absurd. */
export type RetryStrategy =
  | { kind: 'none' }
  | { kind: 'fixed'; baseSeconds: number }
  | { kind: 'exponential'; baseSeconds: number; factor: number; maxSeconds: number }

/** Absurd's cancellation policy jsonb: both fields optional, in seconds. */
export interface CancellationPolicy {
  /** Cancel if never started within N seconds of enqueue. */
  maxDelaySeconds?: number
  /** Cancel if still alive N seconds after first start. */
  maxDurationSeconds?: number
}

export interface SpawnOptions {
  idempotencyKey?: string
  retryStrategy?: RetryStrategy
  maxAttempts?: number
  cancellation?: CancellationPolicy
  headers?: Record<string, string>
  /** Absolute enqueue time override; engine time (DB clock) otherwise. */
  enqueueAtEpochMs?: number
}

export interface SpawnResult {
  taskId: string
  runId: string
  /** False when the idempotency key matched an existing task. */
  created: boolean
}

/**
 * A run claimed by a tick and handed to a worker. `claimToken` and `claimGen`
 * fence every subsequent write (DESIGN.md §3.2): activation is a CAS on
 * `activated_gen < claim_gen`, never a one-shot flag.
 */
export interface ClaimedRun {
  runId: string
  taskId: string
  taskName: string
  attempt: number
  claimGen: number
  claimToken: string
  paramsJson: string
  retryStrategy: RetryStrategy
  maxAttempts: number
  headers: Record<string, string>
  /** Present when this claim is an event/timeout wake. NULL payload = timeout. */
  wakeEvent?: string
  eventPayloadJson?: string | null
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
  | { kind: 'cancelled'; runId: string; taskId: string }

export interface LeaseState {
  held: boolean
  /** Engine-clock milliseconds remaining; 0 when not held. */
  remainingMs: number
}

export interface TaskResult {
  state: TaskState
  completedPayloadJson?: string
  failureReasonJson?: string
}

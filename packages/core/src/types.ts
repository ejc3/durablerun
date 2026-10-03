/**
 * Engine data model, ported from Absurd's t_/r_/c_/e_/w_ tables
 * (DESIGN.md §1.2, §3.4) with the additions from adversarial review:
 * per-claim generations, activation state, and split retry accounting.
 */

/** Canonical runtime partitions for every task/run state consumer. */
export const LIVE_STATES = Object.freeze(['pending', 'running', 'sleeping'] as const)
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled'] as const)
/** The live states a claim may take: a run that is waiting to start or to wake. */
export const QUEUED_STATES = Object.freeze(['pending', 'sleeping'] as const)

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
   * Set by `ctx.spawn` alone, for a child task: the parent's live claim and the call
   * site. The store builds the child's idempotency key from the parent task and the
   * call site, in the engine's reserved namespace, and creates the child only while
   * that claim is live, so knowing a parent's id is not enough to place a task under
   * the key it will look up. A child that exists is found without a live claim, which
   * is what a replay asks. It excludes `idempotencyKey`, and the hosted enqueue route
   * never sets it.
   */
  childOf?: {
    readonly parentQueue: string
    readonly parentTaskId: string
    readonly runId: string
    readonly claimToken: string
    readonly replayKey: string
  }
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

/**
 * A rollback that failed, as `failRollback` takes it (DESIGN.md §3.10): the step, and the
 * failure of this attempt. The store names the attempt record and counts the attempt, so
 * a caller hands over neither.
 */
export interface FailedRollback {
  /** The storage key of the step whose rollback failed. */
  readonly stepKey: string
  /** The failure of this attempt. */
  readonly errorJson: string
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
  /** A cap decided the task's failure and a registered step is owed its rollback (§3.10). */
  | { kind: 'rollback-started'; runId: string; taskId: string; successorRunId: string }
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
  /** Present on a terminal task whose saga began (DESIGN.md §3.10). */
  rollback?: RollbackOutcome
}

/** What a failure did to its task's saga (DESIGN.md §3.10). */
export interface FailOutcome {
  /** The batch placed a rollback pass, so the task is rolling back and has not ended. */
  readonly rollingBack: boolean
}

/**
 * How a saga ended. `failed` means a step that started is left uncompensated, by a
 * rollback that failed for good, a cancellation, or an infrastructure cap. `errorJson`
 * is the failure of the rollback that halted it, when one did.
 */
export interface RollbackOutcome {
  outcome: 'complete' | 'failed'
  errorJson?: string
}

/**
 * A persisted integer an operator read consumed whose stored value is outside the bounds
 * core holds that field to (`PERSISTED_INTEGER_BOUNDS`), or is no exact integer at all. The
 * read reports it here and answers null for the field: it is never skipped and never thrown.
 */
export interface CorruptInteger {
  /** The field as core's bounds name it, such as `runs.claim_gen`. */
  readonly field: string
  /** The run whose row holds it, for a field of a run or of a wait. */
  readonly runId?: string
  /** The step of the wait that holds it. */
  readonly stepName?: string
  /** The event whose row holds it. */
  readonly eventName?: string
  readonly reason: 'not-an-exact-integer' | 'out-of-range'
  /** What kind of value the store returned: `number`, `bigint`, `string`, and so on. */
  readonly stored: string
  /** The stored value as text, when it is a number. A value of any other kind is not copied. */
  readonly value?: string
}

/** A task's own row, as an operator read reports it. */
export interface TaskRowFacts {
  readonly taskId: string
  readonly queue: string
  readonly taskName: string
  /** The stored state, as written. `outcome` says whether the engine's decoder accepts it. */
  readonly state: string
  readonly attempts: number | null
  readonly maxAttempts: number | null
  readonly infraRetries: number | null
  readonly enqueueAtMs: number | null
  readonly firstStartedAtMs: number | null
  /** The cancellation deadline, or null when the task has none. */
  readonly cancelAtMs: number | null
  /** The key the task was spawned under: a caller's, the engine's for a child, or none. */
  readonly idempotencyKey: string | null
  /** The parent a child's key names (`parseChildSpawnKey`), or null for any other key. */
  readonly parentTaskId: string | null
  /** Whether the task's saga began (DESIGN.md §3.10). */
  readonly sagaBegan: boolean
}

/**
 * A task's outcome as `getTaskResult` decodes it, or the words the decoders refused the row
 * with. The words can quote a stored value.
 */
export type TaskOutcomeFacts = { readonly result: TaskResult } | { readonly refused: string }

/** One run of a task, as an operator read reports it. */
export interface RunFacts {
  readonly runId: string
  /** The queue the run's own row names, which is the task's unless the rows are corrupt. */
  readonly queue: string
  readonly state: string
  readonly attempt: number | null
  readonly claimGen: number | null
  readonly activatedGen: number | null
  readonly relaunchCount: number | null
  /** The lease's expiry, or null when the run holds none. */
  readonly claimExpiresAtMs: number | null
  readonly heartbeatAtMs: number | null
  readonly availableAtMs: number | null
  /** The event the run is parked on or was woken by, and the step that awaits it. */
  readonly wakeEvent: string | null
  readonly wakeStep: string | null
  readonly startedAtMs: number | null
  readonly completedAtMs: number | null
  readonly failedAtMs: number | null
}

/** One registered wait of one of a task's runs. */
export interface WaitFacts {
  readonly runId: string
  readonly stepName: string
  readonly eventName: string
  readonly status: string
  /** When the wait times out, or null for a wait with no timeout. */
  readonly timeoutAtMs: number | null
  readonly createdAtMs: number | null
}

/** An event one of a task's runs awaits or was woken by. */
export interface AwaitedEventFacts {
  readonly eventName: string
  /** Whether the event has been emitted, which is whether its row exists. */
  readonly exists: boolean
  readonly emittedAtMs: number | null
}

/**
 * Everything an operator read reports of one task, from one snapshot of the database. It
 * holds no params, headers, event payload, run result or checkpoint state. The outcome is
 * the one `getTaskResult` answers with, so it holds what that holds.
 *
 * Every list has one order on every dialect, and no database collation decides it: runs by
 * their ordinal, then by run id, and waits and events by their names, each compared by its
 * UTF-16 code units.
 */
export interface TaskFacts {
  /** Database time when the snapshot was read. */
  readonly nowMs: number | null
  /** Whether the test clock is set, so `nowMs` is the time a test wrote and not the server's. */
  readonly fakeClock: boolean
  readonly task: TaskRowFacts
  readonly outcome: TaskOutcomeFacts
  readonly runs: readonly RunFacts[]
  readonly waits: readonly WaitFacts[]
  readonly events: readonly AwaitedEventFacts[]
  readonly corrupt: readonly CorruptInteger[]
}

/** Whether an event has been emitted, and when. Nothing here is derived from its payload. */
export interface EventState {
  readonly exists: boolean
  readonly emittedAtMs: number | null
  readonly corrupt: readonly CorruptInteger[]
}

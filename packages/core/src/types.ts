import type { RetryGuardConjunct } from './statements/retry-task.js'
import type { QueueTable } from './store-tables.js'
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
 * core holds that field to (`PERSISTED_INTEGER_BOUNDS`), or is no exact integer at all: a
 * fraction, text, or a NULL in a column the engine writes with every row. The
 * read reports it here and answers null for the field: it is never skipped and never thrown.
 */
export interface CorruptInteger {
  /** The field as core's bounds name it, such as `runs.claim_gen`. */
  readonly field: string
  /** The task whose row holds it, for a field of a task that a read of a queue met. */
  readonly taskId?: string
  /** The run whose row holds it, for a field of a run or of a wait. */
  readonly runId?: string
  /** The step of the wait that holds it. */
  readonly stepName?: string
  /** The event whose row holds it. */
  readonly eventName?: string
  readonly reason: 'not-an-exact-integer' | 'out-of-range'
  /** What kind of value the store returned: `number`, `bigint`, `string`, `null`, and so on. */
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

/**
 * Whether an event has been emitted, and when. It exists once it has been emitted, which is
 * when its row exists, and only an event that exists has an instant. The instant of one
 * that exists is null when the stored value is corrupt, and the `corrupt` list of the same
 * answer names it.
 */
export type EmittedEvent =
  | { readonly exists: false; readonly emittedAtMs: null }
  | { readonly exists: true; readonly emittedAtMs: number | null }

/** An event one of a task's runs awaits or was woken by. */
export type AwaitedEventFacts = { readonly eventName: string } & EmittedEvent

/**
 * Everything an operator read reports of one task. Every member but `fakeClock` is read
 * from one snapshot of the database, and `fakeClock` straight after it. It holds no params,
 * headers, event payload, run result or checkpoint state. The outcome is the one
 * `getTaskResult` answers with, so it holds what that holds.
 *
 * Every list has one order on every dialect, and no database collation decides it: runs by
 * their ordinal and then by run id, waits by run id and then by step, and events by name,
 * each string compared by Unicode code point, which is the order of its UTF-8 bytes.
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
export type EventState =
  | (Extract<EmittedEvent, { exists: false }> & { readonly corrupt: readonly [] })
  | (Extract<EmittedEvent, { exists: true }> & { readonly corrupt: readonly CorruptInteger[] })

/**
 * An event's stored payload, read for its digest. `payloadJson` is the text as stored. It
 * is null for a stored value that is no text, which no engine path writes, and `stored`
 * then names the kind of value the row holds.
 */
export type StoredEventPayload =
  | { readonly exists: false }
  | { readonly exists: true; readonly payloadJson: string }
  | { readonly exists: true; readonly payloadJson: null; readonly stored: string }

/** One run of a task, as the engine's own guards read it at one instant. */
export interface RunAdmission {
  readonly runId: string
  readonly state: string
  readonly claimGen: number | null
  readonly availableAtMs: number | null
  readonly claimExpiresAtMs: number | null
  /** A claim at that instant takes the run: it is due, and the claim's own admission holds of it and of its task. */
  readonly claimTakes: boolean
  /** A sweep at that instant takes the run back: its lease has expired, and the sweep's scan answers it. */
  readonly sweepReclaims: boolean
}

/**
 * What the engine's own guards say of one task at one instant, each as a boolean read
 * from the predicate the engine's statement holds: every conjunct of the retry guard,
 * whether the sweep cancels the task, and of each run whether a claim takes it and whether
 * the sweep takes it back. The state, the deadline, and each run's state, generation and
 * instants are what those answers were read beside, so a reader that holds an earlier
 * snapshot of the task can tell whether the rows moved between the two.
 */
export interface TaskAdmission {
  readonly state: string
  readonly cancelAtMs: number | null
  /**
   * Each conjunct of the retry guard: true when it holds of the task, and false when it
   * does not. A conjunct that computes with counters is asked only where those counters
   * are in range. Where one is not, it is `not-asked`, and the counter's own conjunct is
   * the false one. A revival is refused when any conjunct is false.
   */
  readonly retry: Readonly<Record<RetryGuardConjunct, boolean | 'not-asked'>>
  /** A sweep at that instant cancels the task: it is live and past its deadline, and the sweep's scan answers it. */
  readonly sweepCancels: boolean
  /** Every run that names the task, by its id. */
  readonly runs: readonly RunAdmission[]
  readonly corrupt: readonly CorruptInteger[]
}

/** A list an operator read stopped at a limit: the rows it lists, and whether more exist. */
export interface Capped<Row> {
  readonly rows: readonly Row[]
  /** True when the database holds more rows of this kind than `rows` lists. */
  readonly atLeast: boolean
}

/** A count an operator read stopped at a cap: the count, and whether more rows exist than it. */
export interface Gauge {
  readonly count: number
  /** True when the count is the cap and the database holds more rows than that. */
  readonly atLeast: boolean
}

/** A run a move of the driver is owed to: a claim, for a run that is due and unclaimed. */
export interface OverdueRun {
  readonly runId: string
  readonly taskId: string
  readonly taskName: string
  readonly attempt: number | null
  /** The instant the move came due: when the run became available, or when its lease expired. */
  readonly dueAtMs: number | null
  /** Database time less `dueAtMs`, or null when either is not readable. */
  readonly lateByMs: number | null
}

/** A run whose lease expired, which the sweep takes back. */
export interface LapsedRun extends OverdueRun {
  /**
   * Whether a worker started the run under its newest claim. The sweep fails a run that
   * was started, with a successor while the task has retries left, and reopens a launch
   * that was lost.
   */
  readonly activated: boolean | null
}

/**
 * A list of rows a move is owed to that the engine does not take. It is found through a
 * window: the oldest rows by the leg's instant alone, as many as the limit and two more,
 * of which the leg lists those the engine's own statement does not answer. The window is
 * all the leg reads, so `atLeast` says less here than for a leg read to its end. True says
 * the window showed more such rows than `rows` lists. False says only that the window
 * showed no more: how many lie past it the leg cannot know, and `unexamined` is what says
 * that more may exist.
 */
export interface Windowed<Row> extends Capped<Row> {
  /**
   * True when a row the window did not settle could be one the leg lists under the grace
   * it was asked with: a row it read that sorts after the last row the engine's statement
   * answered and is old enough for the grace, or rows past a window that came back full
   * whose last row is old enough. Such a row that the engine does not take is not listed
   * until the rows ahead of it are taken. False says the window settled every row that is
   * old enough for the grace.
   */
  readonly unexamined: boolean
}

/**
 * A run that is due and that no claim admits: a claim's own statement does not answer it,
 * so no claim takes it however long it has been due. The sweep takes it only by cancelling
 * its task, when the task is past its cancellation deadline and the sweep's scan takes
 * that task: `cancelOverdue` then lists the task. When the scan refuses the task,
 * `deadlineNotCancelled` lists it, and no sweep takes the run. It is read from the run's
 * own row, with no task joined, so it has no task name.
 */
export interface UnadmittedRun {
  readonly runId: string
  readonly taskId: string
  /** The state the run is in: `pending`, or `sleeping` past its wake. */
  readonly state: 'pending' | 'sleeping'
  readonly attempt: number | null
  /** The instant the run became available. */
  readonly dueAtMs: number | null
  readonly lateByMs: number | null
}

/** A running run whose lease has expired and that the sweep's scan does not answer, so no sweep takes it back. */
export interface UnreclaimedRun {
  readonly runId: string
  readonly taskId: string
  readonly attempt: number | null
  /** The instant the lease expired. */
  readonly dueAtMs: number | null
  readonly lateByMs: number | null
}

/** A live task past its cancellation deadline that the sweep's scan does not answer, so no sweep cancels it. */
export interface UncancelledTask {
  readonly taskId: string
  readonly taskName: string
  readonly state: string
  /** The cancellation deadline. */
  readonly dueAtMs: number | null
  readonly lateByMs: number | null
}

/** A live task whose cancellation deadline has passed, which the sweep cancels. */
export interface OverdueTask {
  readonly taskId: string
  readonly taskName: string
  readonly state: string
  /** The task's newest live run, or null when it has none. */
  readonly runId: string | null
  /** The cancellation deadline. */
  readonly dueAtMs: number | null
  readonly lateByMs: number | null
}

/** What `stuckRuns` is asked for. */
export interface StuckRunsOptions {
  /** How long a move must have been owed before its row is listed. Zero lists what the engine would take now. */
  readonly graceSeconds: number
  /** The most rows each leg lists, from 1 to `OPERATOR_LIST_CAP`. */
  readonly limit: number
}

/**
 * The runs and tasks of one queue that a move of the driver is owed to and has been for at
 * least the grace, in seven legs, each oldest first and each stopped at the limit. Four hold
 * what the engine's own statement would take: `dueUnclaimed` and `sleepingPastWake` are the
 * pending and the sleeping runs a claim takes, `leaseLapsed` and `cancelOverdue` are what
 * the sweep's scan finds. A run under a lapsed lease whose task is also past its deadline
 * is in both of the last two, and the sweep takes it by either arm. Three hold what the
 * engine does not take, each beside the legs it completes: `dueNotAdmitted` the due runs
 * no claim admits, `lapsedNotReclaimed` the lapsed leases no sweep takes back, and
 * `deadlineNotCancelled` the passed deadlines no sweep cancels. Each of the three is found
 * through a window of the oldest rows by the instant alone (`Windowed`). Every member but
 * `fakeClock` is read from one snapshot, and `fakeClock` straight after it.
 */
export interface StuckRuns {
  /** Database time as the snapshot's last statement read it. */
  readonly nowMs: number | null
  readonly fakeClock: boolean
  readonly dueUnclaimed: Capped<OverdueRun>
  readonly sleepingPastWake: Capped<OverdueRun>
  readonly dueNotAdmitted: Windowed<UnadmittedRun>
  readonly leaseLapsed: Capped<LapsedRun>
  readonly lapsedNotReclaimed: Windowed<UnreclaimedRun>
  readonly cancelOverdue: Capped<OverdueTask>
  readonly deadlineNotCancelled: Windowed<UncancelledTask>
  readonly corrupt: readonly CorruptInteger[]
}

/**
 * The gauges of one queue, each a count of rows that stops at `OPERATOR_GAUGE_CAP`. A
 * gauge counts rows by their state and their stored instant and applies nothing of a
 * claim's or a sweep's admission, so it is not a count of what the engine would take:
 * `stuckRuns` lists that. A row whose instant is not readable is counted in its state's
 * gauge, in neither gauge of an instant, and listed in `corrupt`.
 */
export interface QueueGauges {
  /** Pending runs. */
  readonly pendingRuns: Gauge
  /** Pending runs whose available instant is at or before database time. */
  readonly pendingRunsDue: Gauge
  /**
   * Sleeping runs that hold a wake instant: a timer, a backoff, or the timeout of an await.
   * A run parked on an await with no timeout holds none and is in no gauge of runs.
   */
  readonly sleepingRuns: Gauge
  /** Sleeping runs whose wake instant is at or before database time. */
  readonly sleepingRunsDue: Gauge
  /** Running runs, which hold a lease. */
  readonly runningRuns: Gauge
  /** Running runs whose lease expiry is at or before database time. */
  readonly runningRunsLapsed: Gauge
  /** Live tasks that have a cancellation deadline. */
  readonly tasksWithADeadline: Gauge
  /** Live tasks whose cancellation deadline is at or before database time. */
  readonly tasksPastTheirDeadline: Gauge
  /** Live tasks: every task that is pending, running or sleeping. */
  readonly liveTasks: Gauge
}

/** What an operator reads of one queue's state. Every member but `fakeClock` is read from one snapshot. */
export interface QueueStatus {
  readonly nowMs: number | null
  readonly fakeClock: boolean
  readonly gauges: QueueGauges
  /**
   * Database time less the earliest instant of a pending or a sleeping run that has come
   * due, or null when none has. It is how long the head of the queue has waited for a claim.
   */
  readonly claimLagMs: number | null
  /**
   * The earliest lease expiry of a running run less database time, or null when no run is
   * running. It is negative once a lease has lapsed.
   */
  readonly leaseHeadroomMs: number | null
  /**
   * The earliest instant a run or a cancellation deadline that a gauge counts holds, past
   * or to come, or null when none holds one. The enqueue instant of a live task is not
   * among them, though the gauge of live tasks reads it: it is when a task entered the
   * queue, and no move comes due at it. Where every stored instant is readable it is the
   * instant the store's own read of a queue's next wake answers.
   */
  readonly nextWakeAtMs: number | null
  /**
   * Database time less the instant the oldest live task was enqueued, or null when the
   * queue holds no live task. It is an age and no lateness: a task is live for as long as
   * its work takes.
   */
  readonly oldestLiveTaskAgeMs: number | null
  readonly corrupt: readonly CorruptInteger[]
}

/** A live task, as the read of a queue's oldest live tasks lists it. */
export interface AgedTask {
  readonly taskId: string
  readonly taskName: string
  readonly state: string
  /** When the task was enqueued. */
  readonly enqueueAtMs: number | null
  /** Database time less `enqueueAtMs`, or null when either is not readable. */
  readonly ageMs: number | null
}

/** What `agedTasks` is asked for. */
export interface AgedTasksOptions {
  /** How long ago a task must have been enqueued to be listed. Zero lists every live task. */
  readonly olderThanSeconds: number
  /** The most tasks listed, from 1 to `OPERATOR_LIST_CAP`. */
  readonly limit: number
}

/**
 * The live tasks of one queue that were enqueued at least so long ago, oldest first and
 * stopped at the limit. It reports an age, and an age is not a defect: nothing says how
 * long a task's work may take. It lists what no leg of `stuckRuns` can, because no move
 * is owed to any of them: a run under a lease its worker keeps alive, a run parked on an
 * event nobody emits, and a task a worker parks again on every tick. Every member but
 * `fakeClock` is read from one snapshot.
 */
export interface AgedTasks {
  readonly nowMs: number | null
  readonly fakeClock: boolean
  readonly tasks: Capped<AgedTask>
  readonly corrupt: readonly CorruptInteger[]
}

/** How many rows of each table one queue holds, each count stopped at `cap`. */
export interface TableRows {
  readonly cap: number
  readonly tables: Readonly<Record<QueueTable, Gauge>>
}

/** One wait registered on an event: the task that waits, its run, and the step that awaits. */
export interface EventWaiter {
  readonly taskId: string
  readonly runId: string
  readonly stepName: string
  /** When the wait times out, or null for a wait with no timeout. */
  readonly timeoutAtMs: number | null
}

/**
 * The waits of one queue that are registered on an event and still waiting, in the order
 * of run and then step, stopped at `OPERATOR_GAUGE_CAP`: the first of them in that order.
 */
export interface EventWaiters {
  readonly waiters: Capped<EventWaiter>
  readonly corrupt: readonly CorruptInteger[]
}

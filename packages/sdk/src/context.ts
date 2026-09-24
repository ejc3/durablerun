import {
  type Checkpoint,
  ChildAwaitRefusedError,
  type ClaimedRun,
  EventTimeoutError,
  type EventWake,
  type FailedRollback,
  FatalTaskError,
  IDENTIFIER_CHARACTERS,
  InvalidDurableStringError,
  type LeaseEnd,
  MAX_COUNT,
  type RetryStrategy,
  type RollbackTry,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_STEP_KEY_CHARACTERS,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  type SpawnOptions,
  type TaskOutcome,
  type TaskThrowableSnapshot,
  TaskTimeoutError,
  UserName,
  type WakeSpec,
  type WorkerClaimedRun,
  decideRetry,
  decodeRollbackTry,
  decodeTaskOutcome,
  fitsCharacters,
  normalizeRetryStrategy,
  parseTaskValueJson,
  serializeTaskValue,
  userDurationToMs,
  userEpochMs,
  userJsonValue,
} from '@durablerun/core'
import { DeliveryOrder, bindOrder } from './delivery-order.js'
import {
  TaskMap,
  taskHasOwn,
  taskMapGet,
  taskMapHas,
  taskMapSet,
  trustedCharCodeAt,
  trustedIsSafeInteger,
  trustedSliceFrom,
  trustedSortNumbers,
  trustedStartsWith,
} from './intrinsics.js'
import {
  type TaskControlIssuer,
  createTaskControlScope,
  trustedStoreControl,
} from './task-control.js'

/**
 * An engine-namespace replay key ('$'-prefixed, so no validated user name
 * can collide with it). Only the static constructors exist: a context
 * method structurally cannot build a durable key from a raw string —
 * every user-supplied part enters through UserName.parse, which is also
 * where the reserved-charset rule lives, once.
 */
class EngineKey {
  private declare readonly engineKeyBrand: undefined

  private constructor(readonly value: string) {}
  static readonly sleep = new EngineKey('$sleep')
  static readonly sleepUntil = new EngineKey('$sleep-until')
  static awaitEvent(name: UserName): EngineKey {
    return new EngineKey(`$await:${name.value}`)
  }
  static spawn(taskName: UserName): EngineKey {
    return new EngineKey(`$spawn:${taskName.value}`)
  }
  static awaitTask(taskId: UserName): EngineKey {
    return new EngineKey(`$await-task:${taskId.value}`)
  }
}

/**
 * Refuse, for good, a name whose durable key would pass the room it has. A durable
 * identifier holds 255 characters (DESIGN.md §3.4 rule 10), and a task's names are stored
 * under keys that are longer than they are: `name#2`, `$await:` and an event name. The
 * store refuses such a key the same way on every pass, so an error that came back from
 * it would be retried, and everything the task did before the call would run again, until
 * the budget was gone. `what` is what the task passed, because the task never sees the key.
 */
function requireRoom(what: string, key: string, room: number): void {
  if (fitsCharacters(key, room)) return
  throw new FatalTaskError(
    room === IDENTIFIER_CHARACTERS
      ? `${what} is too long: it would be stored under a key longer than the ${IDENTIFIER_CHARACTERS} characters a durable identifier holds`
      : `${what} is too long for a step that registers a rollback: its key would be longer than ${room} characters, which is what leaves room for the saga's own names in the ${IDENTIFIER_CHARACTERS} a durable identifier holds`,
  )
}

/**
 * `$order:<n>` records that the result stored under the key it holds was handed to the task
 * function n-th, among the results that were pending together. Only a result that was
 * pending beside another call has one, so a task that makes one call at a time stores none.
 */
const ORDER_PREFIX = '$order:'

/** The number an order marker's name carries, or undefined for a name that is not one. */
function orderNumberOf(name: string): number | undefined {
  if (!trustedStartsWith(name, ORDER_PREFIX)) return undefined
  const digits = trustedSliceFrom(name, ORDER_PREFIX.length)
  if (digits.length === 0 || digits.length > 15) return undefined
  for (let at = 0; at < digits.length; at++) {
    const code = trustedCharCodeAt(digits, at)
    if (code < 48 || code > 57 || (at === 0 && code === 48)) return undefined
  }
  return +digits
}

/** One durable call's life in a pass, from the call to the moment its result reaches the task. */
class CallSpan {
  constructor(
    /** How many calls had been made when this one was, itself included. */
    readonly startNo: number,
    /** Whether another call was pending when this one was made. */
    readonly beganBesideAnother: boolean,
  ) {}
}

/** What a rollback handler is handed (DESIGN.md §3.10). */
export interface RollbackInput<T> {
  /** What the step returned, or undefined when it started and never persisted. Handlers guard on it. */
  readonly output: T | undefined
  /** The failure that decided the task's end, as the task result will report it. */
  readonly error: unknown
  /** The pass's context. A rollback runs as a step, so only what a step may call is open to it. */
  readonly ctx: TaskContext
}

/** A step's compensation. It runs at least once for each time it commits, so it must be idempotent. */
export type RollbackHandler<T> = (input: RollbackInput<T>) => Promise<void> | void

/** A rollback's own retry budget, apart from the task's. */
export interface RollbackConfig {
  /** How many times the rollback may be attempted in all. Defaults to 3. */
  readonly maxAttempts?: number
  /** Defaults to the task's strategy. */
  readonly retryStrategy?: RetryStrategy
}

export interface StepOptions<T> {
  /**
   * Registers the step's compensation. The engine runs it, and only when the task is about
   * to fail for good: an error the task function catches and survives never does. Handlers
   * run in reverse order of step START, each as a durable step of its own.
   */
  readonly rollback?: RollbackHandler<T>
  readonly rollbackConfig?: RollbackConfig
}

/** How often a rollback is attempted when its step does not say. */
const DEFAULT_ROLLBACK_MAX_ATTEMPTS = 3

/** A rollback this pass's replay registered, with what its handler will be handed. */
interface RegisteredRollback {
  readonly name: string
  readonly rollback: RollbackHandler<unknown>
  readonly maxAttempts: number
  readonly retryStrategy: RetryStrategy
  readonly output: unknown
}

type RollbackRegistration = Omit<RegisteredRollback, 'name' | 'output'>

/** What a rollback pass does next. It is a function of the saga's checkpoints and this pass's replay alone. */
export type NextRollback =
  | { readonly kind: 'none' }
  | { readonly kind: 'run'; readonly stepKey: string }
  /** The saga cannot go on, for good: `failed` says why, and its record lands with the halt. */
  | { readonly kind: 'halt'; readonly failed: FailedRollback }

/** A task this task spawned, as `ctx.spawn` returns it and `ctx.awaitTask` takes it. */
export interface ChildTask {
  readonly taskId: string
  readonly queue: string
}

/** What a parent may set on a child. The idempotency key is the engine's: it is what makes a replayed spawn find the same child. */
export type ChildSpawnOptions = Omit<SpawnOptions, 'idempotencyKey' | 'childOf'> & {
  /** The child's queue. It defaults to the parent's, and only a child in the parent's queue can be awaited. */
  queue?: string
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
  step<T>(name: string, fn: () => Promise<T> | T, opts?: StepOptions<T>): Promise<T>
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
  /** First write wins: a later emit cannot replace the stored payload. */
  emitEvent(name: string, payloadJson: string): Promise<void>
  /**
   * Spawn a child task, once. The spawn is memoized like a step, and it carries an
   * idempotency key built from this task and this call site, so a pass that crashed
   * after the spawn and before its checkpoint finds the same child again. A task name
   * follows the rules of a step name: no '#', and no '$' prefix.
   */
  spawn(taskName: string, params: unknown, opts?: ChildSpawnOptions): Promise<ChildTask>
  /**
   * Suspend until the child ends, and resolve to the FIRST outcome it reached:
   * completed, failed, or cancelled. It resolves and does not throw for a failed child,
   * so the parent decides what a failure means. The outcome is memoized, and it stays
   * the first one even if the child is later revived and ends differently. A timeout
   * throws EventTimeoutError. A child in another queue is a permanent failure: events
   * are keyed by queue, so only a child in this task's queue can wake it.
   */
  awaitTask(child: ChildTask, opts?: { timeoutSeconds?: number }): Promise<TaskOutcome>
  /** This attempt's user-visible ordinal (infrastructure retries excluded). */
  readonly attempt: number
  readonly taskName: string
}

/** A wake's outcome arm, without the event and step that located it. */
type WakeOutcome<W> = W extends unknown ? Omit<W, 'event' | 'step'> : never

/**
 * What an await memoizes: the outcome of the wake it consumed. Derived from
 * core's EventWake, so a new wake outcome cannot be missing here.
 */
type EventMemo = WakeOutcome<EventWake>

/** A memo that recorded a timeout, told apart by an own property a polluted prototype cannot forge. */
function isTimedOutMemo(memo: EventMemo): memo is Extract<EventMemo, { timedOut: true }> {
  return taskHasOwn(memo, 'timedOut') && (memo as { timedOut: unknown }).timedOut === true
}

/** What a timed-out await throws, named for what the caller awaited. */
type TimedOut = () => EventTimeoutError

function eventMemoPayload(timedOut: TimedOut, memo: EventMemo): string {
  if (isTimedOutMemo(memo)) throw timedOut()
  return memo.payloadJson
}

/** A wake that delivered a payload, told apart by an own property. */
function isPayloadWake(wake: EventWake): wake is Extract<EventWake, { payloadJson: string }> {
  return taskHasOwn(wake, 'payloadJson')
}

/** The memo a consumed wake records. A new EventWake outcome stops this compiling. */
function memoOfWake(wake: EventWake): EventMemo {
  if (isPayloadWake(wake)) return { payloadJson: wake.payloadJson }
  const timedOut: Extract<EventWake, { timedOut: true }> = wake
  return { timedOut: timedOut.timedOut }
}

/** A child handle read by its own properties, from a caller or from a spawn's memo. */
function childTaskOf(value: unknown): ChildTask {
  if (typeof value === 'object' && value !== null) {
    const taskId = taskHasOwn(value, 'taskId') ? (value as { taskId: unknown }).taskId : undefined
    const queue = taskHasOwn(value, 'queue') ? (value as { queue: unknown }).queue : undefined
    if (typeof taskId === 'string' && typeof queue === 'string') return { taskId, queue }
  }
  throw new FatalTaskError('a child task is what ctx.spawn returned: { taskId, queue }')
}

/** The reason the pass's heartbeat pump saw a refused beat, unset while every beat is held. */
export interface LeaseEndLatch {
  reason: LeaseEnd | undefined
}

/** One execution pass over a claimed run. */
export class ReplayContext implements TaskContext {
  readonly #attempt: number
  readonly taskName: string
  readonly #store: SchedulerStore
  readonly #queue: string
  readonly #run: WorkerClaimedRun
  readonly #leaseEnd: LeaseEndLatch
  readonly #controls: TaskControlIssuer
  private readonly seen = new TaskMap<string, unknown>()
  private readonly nameUses = new TaskMap<string, number>()
  private inStep = false
  /** The order results reach the task in (DESIGN.md §3.2). */
  readonly #order: DeliveryOrder
  /** The number a previous pass recorded for a stored result, by its key. */
  readonly #orderNumbers = new TaskMap<string, number>()
  #callsMade = 0
  #callsPending = 0
  /**
   * The saga as its checkpoints tell it (core `sagas.ts`, specs/Sagas.tla): the start
   * index of every registered step that started, which rollbacks ran, each rollback's
   * failed attempts, and the failure that began the rolling-back phase. Nothing else
   * holds saga state, so a pass that resumes after a crash derives the same sequence.
   */
  private readonly startIndexes = new TaskMap<string, number>()
  private readonly startedKeys: string[] = []
  private readonly rolledBack = new TaskMap<string, true>()
  private readonly rollbackTries = new TaskMap<string, RollbackTry>()
  private readonly registered = new TaskMap<string, RegisteredRollback>()
  private topStartIndex = 0
  /** Every failed rollback attempt on record, over all steps. Each one was followed by a pass. */
  private recordedRollbackTries = 0
  /** The last step at which this pass's replay threw the phase signal for a started step. */
  private replayLastCutAt: string | undefined
  #sagaCauseJson: string | undefined
  /** A saga checkpoint that cannot be read. It reads the same on every pass, so it is permanent. */
  #sagaCorruption: { readonly stepKey: string; readonly message: string } | undefined
  /**
   * The claim's carried wake, held as the ONLY mutable reference to it —
   * takeWake consumes it, and nothing else reads this.#run.wake. Consume-once
   * is then structural, not a discipline: a taken wake is unreadable, so a
   * second await of the same event name cannot re-see it (the stale-wake
   * re-consumption that was the worst confirmed bug of the events review).
   */
  private pendingWake: ClaimedRun['wake']

  constructor(
    store: SchedulerStore,
    queue: string,
    run: WorkerClaimedRun,
    checkpoints: Checkpoint[],
    leaseEnd: LeaseEndLatch = { reason: undefined },
    controls: TaskControlIssuer = createTaskControlScope().issuer,
    attempt: number = run.attempt - run.infraRetries,
  ) {
    this.#store = store
    this.#queue = queue
    this.#run = run
    this.#leaseEnd = leaseEnd
    this.#controls = controls
    this.taskName = run.taskName
    this.pendingWake = run.wake
    for (const cp of checkpoints) {
      taskMapSet(this.seen, cp.checkpointName, parseTaskValueJson(cp.stateJson))
      this.readSagaCheckpoint(cp.checkpointName, cp.stateJson)
    }
    this.#order = this.#readOrder(checkpoints)
    bindOrder(this, this.#order)
    // A rollback pass replays as the run that failed. Each pass is one ordinal past the
    // run before it, so a pass that kept its own ordinal would replay as an attempt that
    // never ran, and a step named after `ctx.attempt` would find no memo and register no
    // rollback. The first pass follows the failed run, and every later pass follows one
    // recorded failed attempt of a rollback, so the passes so far are one more than the
    // attempts recorded. An infrastructure retry of a pass moves no user ordinal.
    this.#attempt =
      this.#sagaCauseJson === undefined ? attempt : attempt - 1 - this.recordedRollbackTries
  }

  /**
   * The recorded order, from the markers whose result is stored. A marker whose result is
   * not stored is one a pass wrote and then died before the result: it names nothing. A key
   * with more than one marker takes the highest, which is the last one written for it.
   */
  #readOrder(checkpoints: readonly Checkpoint[]): DeliveryOrder {
    const numbers: number[] = []
    const keyOf = new TaskMap<number, string>()
    for (const cp of checkpoints) {
      const seq = orderNumberOf(cp.checkpointName)
      const key = taskMapGet(this.seen, cp.checkpointName)
      if (seq === undefined || typeof key !== 'string') continue
      numbers[numbers.length] = seq
      taskMapSet(keyOf, seq, key)
    }
    trustedSortNumbers(numbers)
    // From the highest number down, so the first marker a result is found under is its highest.
    const highestFirst: number[] = []
    for (let at = numbers.length - 1; at >= 0; at--) {
      const seq = numbers[at]
      const key = seq === undefined ? undefined : taskMapGet(keyOf, seq)
      if (seq === undefined || key === undefined) continue
      if (taskMapHas(this.seen, key) && !taskMapHas(this.#orderNumbers, key)) {
        taskMapSet(this.#orderNumbers, key, seq)
        highestFirst[highestFirst.length] = seq
      }
    }
    const recorded: number[] = []
    for (let at = highestFirst.length - 1; at >= 0; at--) {
      const seq = highestFirst[at]
      if (seq !== undefined) recorded[recorded.length] = seq
    }
    return new DeliveryOrder(recorded, numbers[numbers.length - 1] ?? 0)
  }

  /**
   * Every store call of the pass. An infrastructure error that meets a call ends the pass for
   * the flows of its task, whether or not another call is pending when it lands: a flow that
   * has yet to make its first call is beside nothing, and what it stores after the error
   * would be read by a replay with no marker to order it. So the pass stores nothing after
   * that error, it lets every call that waits for its turn go, to meet the error at its own
   * store call, and it does not complete a task that caught the error and returned. The
   * run is retried, and infrastructure retries are not the task's attempts.
   */
  async #storeCall<T>(operation: () => Promise<T>): Promise<T> {
    const ended = this.#order.endedBy
    if (ended !== undefined) throw ended
    try {
      return await this.#controls.storeCall(operation)
    } catch (error) {
      // Only what a retry can fix ends the pass: an outage, a lost lease, a cancelled run. A
      // permanent answer of the store repeats on every retry, so it reaches the task as it did.
      const control = trustedStoreControl(error)
      if (control !== undefined && control.kind !== 'store-permanent') {
        this.#order.end(error as object)
      }
      throw error
    }
  }

  #beginCall(): CallSpan {
    const span = new CallSpan(++this.#callsMade, this.#callsPending > 0)
    this.#callsPending++
    return span
  }

  #endCall(): void {
    this.#callsPending--
  }

  /** Whether another call was pending at some moment of this call's life. */
  #overlapped(span: CallSpan): boolean {
    return span.beganBesideAnother || this.#callsMade > span.startNo
  }

  /** A stored result reaches the task: when every result recorded before it has. */
  async #turnOf(key: string): Promise<void> {
    const seq = taskMapGet(this.#orderNumbers, key)
    if (seq === undefined) return
    const turn = this.#order.wait(seq)
    if (turn !== undefined) await turn
    this.#order.release(seq, true)
  }

  /** The marker of a result: before the result is stored, so a result with a marker was never without one. */
  async #recordOrder(seq: number, key: string): Promise<void> {
    await this.commitCheckpoint(`${ORDER_PREFIX}${seq}`, 'delivery order marker', key)
  }

  /**
   * Store a result this pass produced, and hand it over in its turn. It takes the next
   * number, so it waits for every result before it, the recorded ones included. A result
   * that was pending beside another call is recorded, and its marker is stored first: a
   * marker without a result names nothing, and a result without a marker would be handed
   * over first in a replay. A call that began alone and was joined while it stored is
   * recorded after it stored, and still before it is handed over, so what a replay has of
   * it is what the task saw of it.
   */
  async #commitOrdered(span: CallSpan, key: string, label: string, raw: unknown): Promise<unknown> {
    const seq = this.#order.assign()
    try {
      let recorded = false
      if (this.#overlapped(span)) {
        await this.#recordOrder(seq, key)
        recorded = true
      }
      const value = await this.commitCheckpoint(key, label, raw)
      const turn = this.#order.wait(seq)
      if (turn !== undefined) await turn
      if (!recorded && this.#overlapped(span)) {
        await this.#recordOrder(seq, key)
        recorded = true
      }
      this.#order.release(seq, recorded)
      return value
    } catch (error) {
      this.#order.abandon(seq)
      throw error
    }
  }

  private readSagaCheckpoint(name: string, stateJson: string): void {
    if (name === SAGA_PHASE_CHECKPOINT) {
      this.#sagaCauseJson = stateJson
      return
    }
    if (trustedStartsWith(name, SAGA_STARTED_PREFIX)) {
      const stepKey = trustedSliceFrom(name, SAGA_STARTED_PREFIX.length)
      const index = taskMapGet(this.seen, name)
      if (typeof index !== 'number' || !trustedIsSafeInteger(index) || index < 1) {
        this.#sagaCorruption ??= {
          stepKey,
          message: `the start marker of step '${stepKey}' holds no positive index`,
        }
        return
      }
      taskMapSet(this.startIndexes, stepKey, index)
      this.startedKeys[this.startedKeys.length] = stepKey
      if (index > this.topStartIndex) this.topStartIndex = index
      return
    }
    if (trustedStartsWith(name, SAGA_ROLLBACK_PREFIX)) {
      taskMapSet(this.rolledBack, trustedSliceFrom(name, SAGA_ROLLBACK_PREFIX.length), true)
      return
    }
    if (trustedStartsWith(name, SAGA_TRIES_PREFIX)) {
      const stepKey = trustedSliceFrom(name, SAGA_TRIES_PREFIX.length)
      const record = decodeRollbackTry(stateJson)
      if (record === null) {
        this.#sagaCorruption ??= {
          stepKey,
          message: `the attempt record of the rollback of step '${stepKey}' cannot be read`,
        }
        return
      }
      taskMapSet(this.rollbackTries, stepKey, record)
      this.recordedRollbackTries += record.tries
    }
  }

  get attempt(): number {
    return this.#attempt
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
  private storageName(
    name: UserName | EngineKey,
    what: string,
    room: number = IDENTIFIER_CHARACTERS,
  ): string {
    const raw = name.value
    const use = (taskMapGet(this.nameUses, raw) ?? 0) + 1
    taskMapSet(this.nameUses, raw, use)
    const key = use === 1 ? raw : `${raw}#${use}`
    // The width is held on the way in. A memoized key was admitted by whatever build
    // stored it, and nothing is written under it again, so it replays: refusing it would
    // fail a task in flight for good where it used to finish.
    if (taskMapHas(this.seen, key)) return key
    // A step that started and never persisted is stored too, as its start marker, but its
    // body runs again and its result must then be written under the same key. It is
    // excused the saga room, which its stored marker already passed, and is still held to
    // the width: past it the write can never succeed, so running the body first would
    // only repeat its side effect on every remaining attempt. Once the task is rolling
    // back no body runs, and the key is only what the step's rollback registers under,
    // so nothing is held there and the rollback the first body is owed still runs.
    const started = taskMapHas(this.startIndexes, key)
    if (started && this.#sagaCauseJson !== undefined) return key
    requireRoom(what, key, started ? IDENTIFIER_CHARACTERS : room)
    return key
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
    this.assertLeaseHeld()
    if (this.inStep) {
      throw new FatalTaskError(
        `${what} called inside a step — durable operations cannot nest inside a step`,
      )
    }
  }

  private assertLeaseHeld(): void {
    // A pump beat was refused: stop the handler at the next context call, as
    // the refusal named it. The fences protect STATE regardless; this stops a
    // zombie from burning further side effects and worker time.
    const reason = this.#leaseEnd.reason
    if (reason !== undefined) this.#controls.leaseEnded(reason, this.#run)
  }

  async step<T>(name: string, fn: () => Promise<T> | T, opts?: StepOptions<T>): Promise<T> {
    const parsed = UserName.parse('step name', name)
    this.enterDurableOp(`ctx.step('${name}')`)
    // A registration that cannot be kept is refused here, for good, before the body runs.
    const registration = this.rollbackRegistration(name, opts)
    // A step that registers a rollback also stores saga names built from its key.
    const key = this.storageName(
      parsed,
      'step name',
      registration === undefined ? IDENTIFIER_CHARACTERS : SAGA_STEP_KEY_CHARACTERS,
    )
    const span = this.#beginCall()
    try {
      return await this.#runStep(span, key, name, fn, registration)
    } finally {
      this.#endCall()
    }
  }

  async #runStep<T>(
    span: CallSpan,
    key: string,
    name: string,
    fn: () => Promise<T> | T,
    registration: RollbackRegistration | undefined,
  ): Promise<T> {
    // A memoized step re-registers its closure with what it returned, on every pass.
    if (registration !== undefined && taskMapHas(this.seen, key)) {
      this.register(key, name, registration, taskMapGet(this.seen, key))
    }
    // A memoized result that was recorded is handed over in its turn.
    if (taskMapHas(this.#orderNumbers, key)) await this.#turnOf(key)
    if (taskMapHas(this.seen, key)) {
      return taskMapGet(this.seen, key) as T
    }
    if (this.#sagaCauseJson !== undefined) {
      // The forward phase is frozen. A step that started and never persisted is still
      // owed its rollback, which is handed no output.
      if (registration !== undefined && taskMapHas(this.startIndexes, key)) {
        this.register(key, name, registration, undefined)
      }
      // What this step's body threw before was never stored, so what the step throws now
      // is the engine's signal. A handler that rethrows it ends the replay here, whether
      // or not this step registered a rollback, and a halt at a later step says so.
      this.replayLastCutAt = key
      this.#controls.rollbackPhase()
    }
    // Execute, then commit. A throwing step checkpoints NOTHING — the next
    // attempt re-executes it (retries are the failure story, not replay).
    //
    // The nesting guard goes up before anything here is awaited. A registered step awaits
    // its start marker's write first, and a second durable call made in that window would
    // otherwise pass the guard, read the same highest index, and start beside this step.
    this.inStep = true
    let raw: unknown
    try {
      if (registration !== undefined) {
        // The start marker commits BEFORE the body runs. A step commits only after its
        // body returns, so without the marker a step that started and never persisted
        // would leave nothing for a rollback to find.
        await this.markStarted(key)
        this.register(key, name, registration, undefined)
      }
      raw = await fn()
    } finally {
      this.inStep = false
    }
    const value = await this.#commitOrdered(span, key, `step '${name}' result`, raw)
    if (registration !== undefined) this.register(key, name, registration, value)
    return value as T
  }

  /**
   * What a step's options register, or undefined for a step with no rollback. Bad options
   * are bad on every pass, so they fail the task for good and burn no retry.
   */
  private rollbackRegistration(name: string, opts: unknown): RollbackRegistration | undefined {
    if (opts === undefined) return undefined
    const refuse = (what: string): never => {
      throw new FatalTaskError(`ctx.step('${name}') ${what}`)
    }
    if (typeof opts !== 'object' || opts === null) return refuse('options must be an object')
    const rollback = taskHasOwn(opts, 'rollback')
      ? (opts as { rollback: unknown }).rollback
      : undefined
    const config = taskHasOwn(opts, 'rollbackConfig')
      ? (opts as { rollbackConfig: unknown }).rollbackConfig
      : undefined
    if (rollback === undefined) {
      return config === undefined ? undefined : refuse('has a rollbackConfig and no rollback')
    }
    if (typeof rollback !== 'function') return refuse('rollback must be a function')
    let maxAttempts = DEFAULT_ROLLBACK_MAX_ATTEMPTS
    let retryStrategy: RetryStrategy = this.#run.retryStrategy
    if (config !== undefined) {
      if (typeof config !== 'object' || config === null)
        return refuse('rollbackConfig must be an object')
      const attempts = taskHasOwn(config, 'maxAttempts')
        ? (config as { maxAttempts: unknown }).maxAttempts
        : undefined
      if (attempts !== undefined) {
        // The bound is the one the retry decision enforces. A budget it would refuse when
        // the rollback first fails is refused here instead, before the body runs.
        if (
          typeof attempts !== 'number' ||
          !trustedIsSafeInteger(attempts) ||
          attempts < 1 ||
          attempts > MAX_COUNT
        ) {
          return refuse(`rollbackConfig.maxAttempts must be an integer in [1, ${MAX_COUNT}]`)
        }
        maxAttempts = attempts
      }
      const strategy = taskHasOwn(config, 'retryStrategy')
        ? (config as { retryStrategy: unknown }).retryStrategy
        : undefined
      if (strategy !== undefined) {
        try {
          // Kept as normalized: the form the engine reads, and the one a retry decision takes.
          retryStrategy = normalizeRetryStrategy(strategy)
        } catch (error) {
          return refuse(
            `rollbackConfig.retryStrategy was refused: ${error instanceof Error ? error.message : 'not a retry strategy'}`,
          )
        }
      }
    }
    // A saga checkpoint that cannot be read would order or budget a rollback wrongly.
    const corrupt = this.#sagaCorruption
    if (corrupt !== undefined && this.#sagaCauseJson === undefined) {
      throw new FatalTaskError(`${corrupt.message}, so no step can register a rollback`)
    }
    return { rollback: rollback as RollbackHandler<unknown>, maxAttempts, retryStrategy }
  }

  private register(
    key: string,
    name: string,
    registration: RollbackRegistration,
    output: unknown,
  ): void {
    taskMapSet(this.registered, key, { ...registration, name, output })
  }

  /**
   * Sagas.tla's StartStep. The index is first-write-wins: a step a later attempt runs
   * again finds its marker and keeps its place, and the next start takes the index after
   * the highest one handed out, so no two started steps share one.
   */
  private async markStarted(key: string): Promise<void> {
    if (taskMapHas(this.startIndexes, key)) return
    const index = this.topStartIndex + 1
    await this.commitCheckpoint(`${SAGA_STARTED_PREFIX}${key}`, 'step start marker', index)
    taskMapSet(this.startIndexes, key, index)
    this.startedKeys[this.startedKeys.length] = key
    this.topStartIndex = index
  }

  /** The failure that began the rolling-back phase, as stored, or undefined in the forward phase. */
  get rollingBack(): { readonly causeJson: string } | undefined {
    const causeJson = this.#sagaCauseJson
    return causeJson === undefined ? undefined : { causeJson }
  }

  /**
   * Sagas.tla's RunRollback guard: the step that started last among those not rolled back.
   * A step owed a rollback that this pass's replay did not register cannot be compensated,
   * and an earlier step must not be compensated ahead of it, so the saga halts there.
   */
  nextRollback(): NextRollback {
    const corrupt = this.#sagaCorruption
    if (corrupt !== undefined) {
      return {
        kind: 'halt',
        failed: this.haltFailure(corrupt.stepKey, '$SagaStateCorrupt', corrupt.message),
      }
    }
    let stepKey: string | undefined
    let top = 0
    for (let at = 0; at < this.startedKeys.length; at++) {
      const candidate = this.startedKeys[at]
      if (candidate === undefined || taskMapHas(this.rolledBack, candidate)) continue
      const index = taskMapGet(this.startIndexes, candidate) ?? 0
      if (index > top) {
        top = index
        stepKey = candidate
      }
    }
    if (stepKey === undefined) return { kind: 'none' }
    if (!taskMapHas(this.registered, stepKey)) {
      // The likeliest cause is a handler whose `catch` let the engine's signal through at
      // an earlier step, which ended the replay before it reached this one. Say where.
      const cutAt = this.replayLastCutAt
      const cutEarlier = cutAt !== undefined && (taskMapGet(this.startIndexes, cutAt) ?? 0) < top
      return {
        kind: 'halt',
        failed: this.haltFailure(
          stepKey,
          '$RollbackNotRegistered',
          cutEarlier
            ? `step '${stepKey}' started, and this pass's replay registered no rollback for it. The replay last stopped at step '${cutAt}', which started and never persisted: on a rollback pass that step throws the engine's signal where its body threw before, and the handler must catch it to reach a later step`
            : `step '${stepKey}' started, and this pass's replay registered no rollback for it`,
        ),
      }
    }
    return { kind: 'run', stepKey }
  }

  /** Run one rollback as a step of its own: the handler, then the checkpoint that says it ran. */
  async runRollback(stepKey: string): Promise<void> {
    this.assertLeaseHeld()
    const registered = taskMapGet(this.registered, stepKey)
    const causeJson = this.#sagaCauseJson
    if (registered === undefined || causeJson === undefined) {
      throw new FatalTaskError(`no rollback is owed for step '${stepKey}'`)
    }
    const failure = parseTaskValueJson(causeJson)
    this.inStep = true
    try {
      await registered.rollback({ output: registered.output, error: failure, ctx: this })
    } finally {
      this.inStep = false
    }
    // A rollback is recorded as done only when its compensation happened.
    await this.commitCheckpoint(
      `${SAGA_ROLLBACK_PREFIX}${stepKey}`,
      `rollback of step '${registered.name}'`,
      null,
    )
    taskMapSet(this.rolledBack, stepKey, true)
  }

  /**
   * What a failed rollback owes the store: the step and this attempt's failure, from which
   * the store names and counts the attempt record, and whether the rollback's own budget
   * admits another pass. A fatal error and a spent budget both fail the rollback for good.
   */
  rollbackFailure(
    stepKey: string,
    thrown: TaskThrowableSnapshot,
  ): { readonly failed: FailedRollback; readonly retry: { delaySeconds: number } | null } {
    const registered = taskMapGet(this.registered, stepKey)
    const tries = this.nextTry(stepKey)
    const decision =
      thrown.fatal || registered === undefined
        ? ({ retry: false } as const)
        : decideRetry(registered.retryStrategy, tries, registered.maxAttempts)
    return {
      failed: { stepKey, errorJson: thrown.failureJson },
      retry: decision.retry ? { delaySeconds: decision.delaySeconds } : null,
    }
  }

  /**
   * The attempt a failure of this rollback is: one past those already recorded. A
   * rollback's spent attempts are durable with it, and are never given back. The store
   * counts the same way from the same record when it writes the next one, so this count
   * decides only whether the rollback's budget admits another pass.
   */
  private nextTry(stepKey: string): number {
    return (taskMapGet(this.rollbackTries, stepKey)?.tries ?? 0) + 1
  }

  private haltFailure(stepKey: string, name: string, message: string): FailedRollback {
    return { stepKey, errorJson: serializeTaskValue('rollback failure', { name, message }) }
  }

  /** Every durable call with no memo ends a pass's replay: the forward phase is frozen. */
  private refuseForwardProgress(): void {
    if (this.#sagaCauseJson !== undefined) this.#controls.rollbackPhase()
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
    // An emit stores the name itself and has no memo, so it is always on the way in.
    requireRoom('event name', parsed.value, IDENTIFIER_CHARACTERS)
    // The payload is a user VALUE, and values cross the boundary here.
    const payload = userJsonValue('event payload', payloadJson)
    // A zombie whose lease was lost must not win a first-write event and
    // wake waiters — emitEvent is not fenced by the store (the emit is
    // global), so the pump's refused beat is the only stop. (emitEvent
    // allocates no replay key, so unlike the other durable ops it may run
    // inside a step; hence the bare lease check, not the full nesting gate.)
    this.assertLeaseHeld()
    // The forward phase is frozen, and an emit is forward progress: its waiters would wake
    // on work a rollback is about to compensate. An emit has no memo to say whether the
    // forward pass reached it. One it did reach is first-write-wins, so repeating it would
    // change nothing. A rollback pass's replay therefore emits nothing, and it goes on:
    // ending the replay here would leave every later step's rollback unregistered. A
    // rollback handler runs as a step of its own, and a step may emit.
    if (this.#sagaCauseJson !== undefined && !this.inStep) return
    await this.#storeCall(() => this.#store.emitEvent(this.#queue, parsed.value, payload))
  }

  async awaitEvent(name: string, opts?: { timeoutSeconds?: number }): Promise<string> {
    const parsed = UserName.parse('event name', name)
    this.enterDurableOp('ctx.awaitEvent')
    const timeoutSeconds = opts?.timeoutSeconds
    if (timeoutSeconds !== undefined) {
      userDurationToMs('awaitEvent timeoutSeconds', timeoutSeconds, { positive: true })
    }
    const key = this.storageName(EngineKey.awaitEvent(parsed), 'event name')
    const timedOut: TimedOut = () => new EventTimeoutError(name)
    const span = this.#beginCall()
    try {
      const settled = await this.settledAwait(span, timedOut, key)
      if (settled !== undefined) return settled
      const outcome = await this.#storeCall(() =>
        this.#store.awaitEvent(
          this.#queue,
          this.#run.taskId,
          this.#run.runId,
          this.#run.claimToken,
          key,
          // parsed.value, not `name` — emitEvent already sends the parsed form,
          // and the two must be the same string or a wait registers under one
          // spelling while the emit fires the other and never matches it. They
          // are identical today because parse only validates; the moment it
          // normalizes anything, the raw path becomes a silent lost wakeup. The
          // validated value is the canonical one, so nothing downstream should
          // read the raw one again.
          parsed.value,
          timeoutSeconds ?? null,
        ),
      )
      return await this.registeredAwait(span, timedOut, key, outcome)
    } finally {
      this.#endCall()
    }
  }

  async spawn(taskName: string, params: unknown, opts?: ChildSpawnOptions): Promise<ChildTask> {
    const parsed = UserName.parse('task name', taskName)
    this.enterDurableOp(`ctx.spawn('${taskName}')`)
    const key = this.storageName(EngineKey.spawn(parsed), 'task name')
    const span = this.#beginCall()
    try {
      return await this.#runSpawn(span, key, parsed, taskName, params, opts)
    } finally {
      this.#endCall()
    }
  }

  async #runSpawn(
    span: CallSpan,
    key: string,
    parsed: UserName,
    taskName: string,
    params: unknown,
    opts: ChildSpawnOptions | undefined,
  ): Promise<ChildTask> {
    if (taskMapHas(this.#orderNumbers, key)) await this.#turnOf(key)
    if (taskMapHas(this.seen, key)) return childTaskOf(taskMapGet(this.seen, key))
    this.refuseForwardProgress()
    const paramsJson = serializeTaskValue('child task params', params)
    const { queue: childQueue, ...spawnOptions } = opts ?? {}
    const queue = childQueue === undefined ? this.#queue : childQueue
    // A queue name is durable, and this is the first one task code chooses. The spawn port
    // refuses one that no store keeps unchanged, and the catch below makes that permanent.
    if (typeof queue !== 'string' || queue === '') {
      throw new FatalTaskError(`ctx.spawn('${taskName}') queue must be a non-empty string`)
    }
    // The child is keyed by this task and this call site, so every pass, every retry,
    // and a pass that died between the spawn and its checkpoint all find one child. The
    // store builds the key, in a namespace its port refuses to every caller's own key.
    const childOf = {
      parentQueue: this.#queue,
      parentTaskId: this.#run.taskId,
      runId: this.#run.runId,
      claimToken: this.#run.claimToken,
      replayKey: key,
    }
    let spawned: Awaited<ReturnType<SchedulerStore['spawn']>>
    try {
      spawned = await this.#storeCall(() =>
        this.#store.spawn(queue, parsed.value, paramsJson, { ...spawnOptions, childOf }),
      )
    } catch (error) {
      // The store refuses an invalid option the same way on every pass, so retrying
      // the task would only repeat the refusal. A queue no store can keep is refused
      // with InvalidDurableStringError, which is a TypeError and not a RangeError.
      if (error instanceof RangeError || error instanceof InvalidDurableStringError) {
        throw new FatalTaskError(`ctx.spawn('${taskName}') was refused: ${error.message}`)
      }
      throw error
    }
    return childTaskOf(
      await this.#commitOrdered(span, key, 'child task', { taskId: spawned.taskId, queue }),
    )
  }

  async awaitTask(child: ChildTask, opts?: { timeoutSeconds?: number }): Promise<TaskOutcome> {
    const taskId = UserName.parse('child task id', childTaskOf(child).taskId)
    this.enterDurableOp('ctx.awaitTask')
    // Read once: the value validated is the value sent.
    const timeout = opts?.timeoutSeconds
    if (timeout !== undefined) {
      userDurationToMs('awaitTask timeoutSeconds', timeout, { positive: true })
    }
    const key = this.storageName(EngineKey.awaitTask(taskId), 'child task id')
    // The task sees the task it awaited, never the engine's name for the event.
    const timedOut: TimedOut = () => new TaskTimeoutError(taskId.value)
    const span = this.#beginCall()
    try {
      const settled = await this.settledAwait(span, timedOut, key)
      if (settled !== undefined) return decodeTaskOutcome(taskId.value, settled)
      const outcome = await this.#storeCall(() =>
        this.#store.awaitTaskDone(
          this.#queue,
          this.#run.taskId,
          this.#run.runId,
          this.#run.claimToken,
          key,
          taskId.value,
          timeout === undefined ? null : timeout,
        ),
      )
      return decodeTaskOutcome(
        taskId.value,
        await this.registeredAwait(span, timedOut, key, outcome),
      )
    } catch (error) {
      // Neither changes on a retry: the child's queue, so the refusal, and a recorded
      // outcome that cannot be read, which the store and the decoder refuse with
      // RangeError. Retrying would rerun every side effect before the await for nothing.
      if (error instanceof ChildAwaitRefusedError || error instanceof RangeError) {
        throw new FatalTaskError(error.message)
      }
      throw error
    } finally {
      this.#endCall()
    }
  }

  /**
   * An await that needs no store call: its memo, or the wake this claim carried for
   * it. An empty payload is still an answer, and only undefined means unsettled.
   */
  private async settledAwait(
    span: CallSpan,
    timedOut: TimedOut,
    key: string,
  ): Promise<string | undefined> {
    if (taskMapHas(this.seen, key)) {
      // A memo already covers THIS await (matched by its step key): retire
      // its carried wake so it cannot be re-read; a wake for a different
      // await (same event name, different step) is left untouched.
      this.takeWake(key)
      if (taskMapHas(this.#orderNumbers, key)) await this.#turnOf(key)
      return eventMemoPayload(timedOut, taskMapGet(this.seen, key) as EventMemo)
    }
    // Ahead of the carried wake: consuming one commits a memo, which is forward progress.
    this.refuseForwardProgress()
    // A wake delivered with this claim resolves the await, consumed once:
    // the run row's wake fields persist after delivery, so matching by the
    // unique step key (not the shared event name) keeps a later same-name
    // await from stealing this one's wake.
    const wake = this.takeWake(key)
    return wake ? this.commitEventMemo(span, timedOut, key, memoOfWake(wake)) : undefined
  }

  /** What the store's await answered: the event's payload, or a run the batch already parked. */
  private async registeredAwait(
    span: CallSpan,
    timedOut: TimedOut,
    key: string,
    outcome: { emitted: true; payloadJson: string } | { emitted: false },
  ): Promise<string> {
    if (outcome.emitted) {
      return this.commitEventMemo(span, timedOut, key, { payloadJson: outcome.payloadJson })
    }
    // The store batch ALREADY parked the run: signal without a wake so the
    // runtime performs no second suspension.
    this.#controls.awaitEvent()
  }

  /**
   * The one lease-fenced checkpoint commit, shared by steps and await markers.
   * ONE representation: the memo, and a step's return value on the executing
   * pass, are the serialize-then-parse CANONICAL value, so NaN, Dates, dropped
   * undefined fields, and -0 read identically on every pass of every schedule.
   * Serializing here keeps every stored value on that one path.
   */
  private async commitCheckpoint(key: string, label: string, raw: unknown): Promise<unknown> {
    const stateJson = serializeTaskValue(label, raw)
    const value = parseTaskValueJson(stateJson)
    await this.#storeCall(() =>
      this.#store.setCheckpoint(
        this.#queue,
        this.#run.taskId,
        this.#run.runId,
        this.#run.claimToken,
        key,
        stateJson,
        this.#run.leaseSeconds,
      ),
    )
    taskMapSet(this.seen, key, value)
    return value
  }

  /** Commit an await's memo, then resolve it exactly as a replay of that memo would. */
  private async commitEventMemo(
    span: CallSpan,
    timedOut: TimedOut,
    key: string,
    memo: EventMemo,
  ): Promise<string> {
    await this.#commitOrdered(span, key, 'event wake marker', memo)
    return eventMemoPayload(timedOut, memo)
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
  private async suspendPoint(kind: EngineKey, wake: WakeSpec): Promise<void> {
    const key = this.storageName(kind, 'sleep')
    const span = this.#beginCall()
    try {
      await this.#suspendAt(span, key, wake)
    } finally {
      this.#endCall()
    }
  }

  async #suspendAt(span: CallSpan, key: string, wake: WakeSpec): Promise<void> {
    if (taskMapHas(this.#orderNumbers, key)) await this.#turnOf(key)
    if (taskMapHas(this.seen, key)) return // the wake already happened: continue
    this.refuseForwardProgress()
    // The marker lands with the park, which ends the pass. What is recorded of a sleep is
    // its place among the results before it, so its number is stored ahead of the park.
    if (this.#overlapped(span)) await this.#recordOrder(this.#order.reserve(), key)
    this.#controls.sleep(wake, {
      key,
      stateJson: serializeTaskValue('sleep marker', wake),
    })
  }
}

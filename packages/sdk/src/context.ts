import {
  type Checkpoint,
  ChildAwaitRefusedError,
  type ClaimedRun,
  EventTimeoutError,
  type EventWake,
  FatalTaskError,
  InvalidDurableStringError,
  type LeaseEnd,
  type SchedulerStore,
  type SpawnOptions,
  type TaskOutcome,
  TaskTimeoutError,
  UserName,
  type WakeSpec,
  type WorkerClaimedRun,
  decodeTaskOutcome,
  parseTaskValueJson,
  requireDurableString,
  serializeTaskValue,
  userDurationToMs,
  userEpochMs,
  userJsonValue,
} from '@durablerun/core'
import { TaskMap, taskHasOwn, taskMapGet, taskMapHas, taskMapSet } from './intrinsics.js'
import { type TaskControlIssuer, createTaskControlScope } from './task-control.js'

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
    this.#attempt = attempt
    this.taskName = run.taskName
    this.pendingWake = run.wake
    for (const cp of checkpoints) {
      taskMapSet(this.seen, cp.checkpointName, parseTaskValueJson(cp.stateJson))
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
  private storageName(name: UserName | EngineKey): string {
    const raw = name.value
    const use = (taskMapGet(this.nameUses, raw) ?? 0) + 1
    taskMapSet(this.nameUses, raw, use)
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

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const parsed = UserName.parse('step name', name)
    this.enterDurableOp(`ctx.step('${name}')`)
    const key = this.storageName(parsed)
    if (taskMapHas(this.seen, key)) {
      return taskMapGet(this.seen, key) as T
    }
    // Execute, then commit. A throwing step checkpoints NOTHING — the next
    // attempt re-executes it (retries are the failure story, not replay).
    this.inStep = true
    let raw: unknown
    try {
      raw = await fn()
    } finally {
      this.inStep = false
    }
    return (await this.commitCheckpoint(key, `step '${name}' result`, raw)) as T
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
    // The payload is a user VALUE, and values cross the boundary here.
    const payload = userJsonValue('event payload', payloadJson)
    // A zombie whose lease was lost must not win a first-write event and
    // wake waiters — emitEvent is not fenced by the store (the emit is
    // global), so the pump's refused beat is the only stop. (emitEvent
    // allocates no replay key, so unlike the other durable ops it may run
    // inside a step; hence the bare lease check, not the full nesting gate.)
    this.assertLeaseHeld()
    await this.#controls.storeCall(() => this.#store.emitEvent(this.#queue, parsed.value, payload))
  }

  async awaitEvent(name: string, opts?: { timeoutSeconds?: number }): Promise<string> {
    const parsed = UserName.parse('event name', name)
    this.enterDurableOp('ctx.awaitEvent')
    const timeoutSeconds = opts?.timeoutSeconds
    if (timeoutSeconds !== undefined) {
      userDurationToMs('awaitEvent timeoutSeconds', timeoutSeconds, { positive: true })
    }
    const key = this.storageName(EngineKey.awaitEvent(parsed))
    const timedOut: TimedOut = () => new EventTimeoutError(name)
    const settled = await this.settledAwait(timedOut, key)
    if (settled !== undefined) return settled
    const outcome = await this.#controls.storeCall(() =>
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
    return this.registeredAwait(timedOut, key, outcome)
  }

  async spawn(taskName: string, params: unknown, opts?: ChildSpawnOptions): Promise<ChildTask> {
    const parsed = UserName.parse('task name', taskName)
    this.enterDurableOp(`ctx.spawn('${taskName}')`)
    const key = this.storageName(EngineKey.spawn(parsed))
    if (taskMapHas(this.seen, key)) return childTaskOf(taskMapGet(this.seen, key))
    const paramsJson = serializeTaskValue('child task params', params)
    const { queue: childQueue, ...spawnOptions } = opts ?? {}
    const queue = childQueue === undefined ? this.#queue : childQueue
    // A queue name is durable, and this is the first one task code chooses. One that no
    // store keeps unchanged is refused here, for good, like a step name that is not.
    if (typeof queue !== 'string' || queue === '') {
      throw new FatalTaskError(`ctx.spawn('${taskName}') queue must be a non-empty string`)
    }
    try {
      requireDurableString(`ctx.spawn('${taskName}') queue`, queue)
    } catch (error) {
      throw new FatalTaskError(error instanceof Error ? error.message : 'queue is not durable')
    }
    // The child is keyed by this task and this call site, so every pass, every retry,
    // and a pass that died between the spawn and its checkpoint all find one child. The
    // store builds the key, in a namespace its port refuses to every caller's own key.
    const childOf = { parentTaskId: this.#run.taskId, replayKey: key }
    let spawned: Awaited<ReturnType<SchedulerStore['spawn']>>
    try {
      spawned = await this.#controls.storeCall(() =>
        this.#store.spawn(queue, parsed.value, paramsJson, { ...spawnOptions, childOf }),
      )
    } catch (error) {
      // The store refuses an invalid option the same way on every pass, so retrying
      // the task would only repeat the refusal. A header no store can keep is refused
      // with InvalidDurableStringError, which is a TypeError and not a RangeError.
      if (error instanceof RangeError || error instanceof InvalidDurableStringError) {
        throw new FatalTaskError(`ctx.spawn('${taskName}') was refused: ${error.message}`)
      }
      throw error
    }
    return childTaskOf(
      await this.commitCheckpoint(key, 'child task', { taskId: spawned.taskId, queue }),
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
    const key = this.storageName(EngineKey.awaitTask(taskId))
    // The task sees the task it awaited, never the engine's name for the event.
    const timedOut: TimedOut = () => new TaskTimeoutError(taskId.value)
    const settled = await this.settledAwait(timedOut, key)
    if (settled !== undefined) return decodeTaskOutcome(taskId.value, settled)
    let outcome: Awaited<ReturnType<SchedulerStore['awaitTaskDone']>>
    try {
      outcome = await this.#controls.storeCall(() =>
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
    } catch (error) {
      // The child's queue never changes, so neither does the refusal.
      if (error instanceof ChildAwaitRefusedError) throw new FatalTaskError(error.message)
      throw error
    }
    return decodeTaskOutcome(taskId.value, await this.registeredAwait(timedOut, key, outcome))
  }

  /**
   * An await that needs no store call: its memo, or the wake this claim carried for
   * it. An empty payload is still an answer, and only undefined means unsettled.
   */
  private async settledAwait(timedOut: TimedOut, key: string): Promise<string | undefined> {
    if (taskMapHas(this.seen, key)) {
      // A memo already covers THIS await (matched by its step key): retire
      // its carried wake so it cannot be re-read; a wake for a different
      // await (same event name, different step) is left untouched.
      this.takeWake(key)
      return eventMemoPayload(timedOut, taskMapGet(this.seen, key) as EventMemo)
    }
    // A wake delivered with this claim resolves the await, consumed once:
    // the run row's wake fields persist after delivery, so matching by the
    // unique step key (not the shared event name) keeps a later same-name
    // await from stealing this one's wake.
    const wake = this.takeWake(key)
    return wake ? this.commitEventMemo(timedOut, key, memoOfWake(wake)) : undefined
  }

  /** What the store's await answered: the event's payload, or a run the batch already parked. */
  private async registeredAwait(
    timedOut: TimedOut,
    key: string,
    outcome: { emitted: true; payloadJson: string } | { emitted: false },
  ): Promise<string> {
    if (outcome.emitted) {
      return this.commitEventMemo(timedOut, key, { payloadJson: outcome.payloadJson })
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
    await this.#controls.storeCall(() =>
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
  private async commitEventMemo(timedOut: TimedOut, key: string, memo: EventMemo): Promise<string> {
    await this.commitCheckpoint(key, 'event wake marker', memo)
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
    const key = this.storageName(kind)
    if (taskMapHas(this.seen, key)) return // the wake already happened: continue
    this.#controls.sleep(wake, {
      key,
      stateJson: serializeTaskValue('sleep marker', wake),
    })
  }
}

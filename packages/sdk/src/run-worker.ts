import {
  type ClaimedRunAnswerReadField,
  type Clock,
  type FailOutcome,
  type LaunchInvocation,
  type SchedulerStore,
  decideRetry,
  decodeClaimedRunAnswer,
  parseTaskValueJson,
  serializeTaskValue,
  snapshotTaskThrowable,
} from '@durablerun/core'
import { type LeaseEndLatch, ReplayContext, type TaskContext } from './context.js'
import { beatOrder, bindTurn, endedBy, openOrder, replaySettled } from './delivery-order.js'
import {
  TaskAbortController,
  abortControllerAbort,
  abortControllerSignal,
  abortSignalAborted,
  taskRegistryGet,
  trustedCharCodeAt,
  trustedPromiseRace,
} from './intrinsics.js'
import {
  type TaskControlSnapshot,
  createTaskControlScope,
  trustedStoreControl,
} from './task-control.js'

/** A registered durable task function. Params arrive parsed from JSON. */
export type TaskHandler = (ctx: TaskContext, params: unknown) => Promise<unknown>
/**
 * A Map's stored entries are authoritative; Map-subclass `get` overrides are
 * not dispatch authority. A non-Map structural implementation is trusted host
 * resolver code and owns the safety of its own ambient dependencies.
 */
export type TaskRegistry = ReadonlyMap<string, TaskHandler>

/** What one worker invocation did with its run (DESIGN.md §3.2). */
export type WorkerOutcome =
  | { kind: 'completed' }
  | { kind: 'suspended' } // sleep/await: parked, will wake later
  | { kind: 'retry-scheduled' } // user failure with retries left
  | { kind: 'failed' } // user failure, terminal
  | { kind: 'rolling-back' } // the failure was decided, or a rollback failed with budget
  //   left, and a rollback pass follows: the task has not ended (DESIGN.md §3.10)
  | { kind: 'rolled-back' } // a pass found nothing left to roll back, and ended the task
  | { kind: 'rollback-failed' } // a rollback failed for good: the saga halted, and the task ended
  | { kind: 'superseded' } // duplicate delivery / stale claim: did nothing
  | { kind: 'lease-lost' } // lost the lease mid-run: aborted quietly
  | { kind: 'cancelled' } // the task was cancelled mid-run (AB001): aborted quietly
  | { kind: 'aborted' } // store unreachable mid-pass, or its answer was permanent: user budget untouched
  //   and the lease story recovers. NOTE: 'unreachable' includes a lost
  //   RESPONSE — the write may or may not have committed; recovery is
  //   correct either way (fences + sweep), but do not read 'aborted' as
  //   proof that nothing changed.
  | { kind: 'deferred' } // unknown task name: parked untouched for a
  //                        worker build that knows it (rolling deploys)
  | { kind: 'incompatible-store'; field: ClaimedRunAnswerReadField | 'answer' }
//   the activation answer lacks or malforms a field this worker reads: no user code
//   ran and nothing was written, so the lease story recovers the run for a compatible
//   build, charged as infrastructure

/** The launch fields a worker needs: the ids of one claim. */
export type RunInvocation = Pick<LaunchInvocation, 'queue' | 'runId' | 'claimToken' | 'claimGen'>

/**
 * Classify a store-call rejection. Used only immediately around a store call,
 * where origin rather than a user-constructible public class grants
 * infrastructure authority. Anything that is not infrastructure is rethrown.
 */
function trustedStoreOutcome(error: unknown): WorkerOutcome {
  const outcome = infrastructureOutcome(trustedStoreControl(error))
  if (outcome !== undefined) return outcome
  throw error
}

/**
 * The infrastructure-failure classification, in ONE place: a lost lease and
 * a store outage each abort the pass without spending the user's budget,
 * and every transition write (complete, suspend, fail, the rolling-deploy
 * defer) and the handler boundary must treat them identically. Two of the
 * five call sites once open-coded this and silently dropped the outage arm; a
 * single definition makes that divergence unwritable, and the exhaustive
 * switch makes a new control kind fail typecheck here instead of falling
 * through to a user failure.
 */
function infrastructureOutcome(
  control: TaskControlSnapshot | undefined,
): WorkerOutcome | undefined {
  if (control === undefined) return undefined
  switch (control.kind) {
    // A suspension and the frozen phase's signal are the pass's own business.
    case 'sleep':
    case 'await-event':
    case 'rollback-phase':
      return undefined
    case 'lease-lost':
      return { kind: 'lease-lost' }
    case 'run-cancelled':
      return { kind: 'cancelled' }
    case 'store-unavailable':
    // A permanent answer of the store ends the pass exactly as an outage does. It is not
    // the task's failure, so it may not spend the task's attempts, and no transition exists
    // yet that ends a run for it (DESIGN.md §3.2).
    case 'store-permanent':
      return { kind: 'aborted' }
    default:
      return control satisfies never
  }
}

/**
 * Execute one claimed run to its next suspension point or terminal state.
 * Transport-free: the HTTP worker server (driver package) wraps this; tests
 * call it directly. The contract, in order:
 *
 * 1. A claimed task name this build does not know, read from the store, is
 *    DEFERRED before activation (parked ~15s with its carried wake preserved,
 *    nothing consumed, the first start never latched), so deploy workers before
 *    producers and old runs survive new code.
 * 2. Activation is the gate: the per-claim compare-and-swap admits exactly
 *    one invocation per claim — a duplicate delivery, a superseded claim,
 *    or a swept lease all exit here having touched nothing.
 * 3. User code runs under a heartbeat pump that re-extends the lease at
 *    half-lease cadence; a lost lease aborts the pass quietly (the store
 *    fences every write, so a zombie cannot commit anything anyway).
 * 4. Exactly one transition ends the pass: complete, reschedule (suspend),
 *    or fail — with the retry decision made by core over the USER attempt
 *    ordinal (infrastructure retries never consume the user's budget).
 */
export async function runClaimedRun(
  deps: { store: SchedulerStore; clock: Clock; registry: TaskRegistry },
  invocation: RunInvocation,
): Promise<WorkerOutcome> {
  const { store, clock, registry } = deps
  const { queue, runId, claimToken, claimGen } = invocation

  // The launch carries only ids; the claimed task's name comes from the store,
  // so no payload can name a task the claim does not hold. A null answer means
  // the claim was superseded or already activated by another delivery.
  let taskName: string | null
  try {
    taskName = await store.claimedTaskName(queue, runId, claimToken, claimGen)
  } catch (error) {
    return trustedStoreOutcome(error)
  }
  if (taskName === null) return { kind: 'superseded' }
  // One lookup: the handler resolved here is the handler dispatched below.
  const handler = taskRegistryGet(registry, taskName)
  if (handler === undefined) {
    // Rolling-deploy rule: defer BEFORE activation, so a build
    // without this task's handler consumes nothing and never latches the first
    // start, which would disarm the start deadline and start the duration
    // clock. The jitter is derived from the run id (no ambient randomness in
    // engine code) so a fleet of stale workers spreads its retries instead of
    // thundering.
    let jitterTotal = 0
    for (let index = 0; index < runId.length; index++) {
      jitterTotal += trustedCharCodeAt(runId, index)
    }
    try {
      await store.deferLaunch(queue, runId, claimToken, claimGen, 15 + (jitterTotal % 10))
    } catch (error) {
      return trustedStoreOutcome(error)
    }
    return { kind: 'deferred' }
  }

  let answer: Awaited<ReturnType<SchedulerStore['activate']>>
  try {
    answer = await store.activate(queue, runId, claimToken, claimGen)
  } catch (error) {
    return trustedStoreOutcome(error)
  }
  if (answer === null) return { kind: 'superseded' }
  // A store built from another commit may answer without a field this worker reads,
  // or with a malformed one. Refuse before any user code runs, naming the field, and
  // run on the decoded answer rather than the store's object.
  const decoded = decodeClaimedRunAnswer(answer)
  if (!decoded.ok) return { kind: 'incompatible-store', field: decoded.field }
  const run = decoded.run
  const userAttempt = run.attempt - run.infraRetries

  // Heartbeat pump FIRST (before any further unfenced reads): extend at
  // half-lease cadence until the pass ends. A refused heartbeat names why:
  // the task was cancelled, or the lease is lost. The fences already refuse a
  // zombie's writes; the recorded reason additionally stops the HANDLER at its
  // next context call, so a zombie stops burning side effects too.
  const pumpStop = new TaskAbortController()
  const pumpStopSignal = abortControllerSignal(pumpStop)
  const leaseEnd: LeaseEndLatch = { reason: undefined }
  const leaseMs = run.leaseSeconds * 1000
  /** The pass's context once it exists, so each beat of the heartbeat can look at its order. */
  let passContext: ReplayContext | undefined
  const pump = (async () => {
    for (;;) {
      await clock.sleep(leaseMs / 2, pumpStopSignal)
      if (abortSignalAborted(pumpStopSignal)) return
      if (passContext !== undefined) beatOrder(passContext)
      try {
        const lease = await store.heartbeat(queue, runId, claimToken, run.leaseSeconds)
        if (!lease.held) {
          // A store built against the earlier contract names no reason: that is a lost lease.
          leaseEnd.reason = lease.reason === 'cancelled' ? 'cancelled' : 'lease-lost'
          // The pass is over, and a call that waits for its turn would wait for ever.
          if (passContext !== undefined) openOrder(passContext)
          return
        }
      } catch {
        // Heartbeat is advisory upkeep; the fences are the truth. With no more beats, a call
        // that waits for its turn has nobody left to give up on its number.
        if (passContext !== undefined) openOrder(passContext)
        return
      }
    }
  })()

  try {
    let checkpoints: Awaited<ReturnType<SchedulerStore['getCheckpoints']>>
    try {
      checkpoints = await store.getCheckpoints(queue, run.taskId, run.attempt)
    } catch (error) {
      return trustedStoreOutcome(error)
    }
    const taskControls = createTaskControlScope()
    const ctx = new ReplayContext(
      store,
      queue,
      run,
      checkpoints,
      leaseEnd,
      taskControls.issuer,
      userAttempt,
    )

    async function recordUserFailure(error: unknown): Promise<WorkerOutcome> {
      const thrown = snapshotTaskThrowable(error)
      const decision = thrown.fatal
        ? ({ retry: false } as const)
        : decideRetry(run.retryStrategy, userAttempt, run.maxAttempts)
      try {
        // A store built before sagas answers nothing: its task is not rolling back.
        const failed: FailOutcome | undefined = await store.fail(
          queue,
          runId,
          claimToken,
          thrown.failureJson,
          decision.retry ? { delaySeconds: decision.delaySeconds } : null,
        )
        // The store decides: a step that started is owed a rollback, so the task lives on.
        if (failed?.rollingBack === true) return { kind: 'rolling-back' }
      } catch (inner) {
        return trustedStoreOutcome(inner)
      }
      return decision.retry ? { kind: 'retry-scheduled' } : { kind: 'failed' }
    }

    passContext = ctx
    bindTurn(ctx, () => clock.yieldTurn())

    /**
     * A rollback pass (DESIGN.md §3.10, specs/Sagas.tla). The task function runs again so
     * every memoized step re-registers its closure, and however that replay ends, its
     * ending means nothing: the failure is decided. Then each rollback owed runs as a
     * step of its own, the step that started last first, until none is left, one fails,
     * or the saga cannot go on. Exactly one write ends the pass, as it ends any pass.
     */
    const rollBack = async (params: unknown, causeJson: string): Promise<WorkerOutcome> => {
      try {
        await handler(ctx, params)
      } catch (error) {
        const infrastructure = infrastructureOutcome(taskControls.snapshot(error))
        if (infrastructure !== undefined) return infrastructure
      }
      // A flow of the task that the replay held for its turn registers its rollbacks after
      // the flow that ended the replay threw. What is owed is decided only when none is left.
      await replaySettled(ctx)
      for (;;) {
        const next = ctx.nextRollback()
        if (next.kind === 'run') {
          try {
            await ctx.runRollback(next.stepKey)
            continue
          } catch (error) {
            const infrastructure = infrastructureOutcome(taskControls.snapshot(error))
            if (infrastructure !== undefined) return infrastructure
            // The attempt record lands with the failure, so a failed attempt is counted.
            const failure = ctx.rollbackFailure(next.stepKey, snapshotTaskThrowable(error))
            try {
              const placed = await store.failRollback(
                queue,
                runId,
                claimToken,
                causeJson,
                failure.retry,
                failure.failed,
              )
              // The store says whether a pass follows. It can end the task where the retry
              // decision asked for a pass, when the pass does not fit the budget bound.
              return placed.rollingBack ? { kind: 'rolling-back' } : { kind: 'rollback-failed' }
            } catch (inner) {
              return trustedStoreOutcome(inner)
            }
          }
        }
        try {
          // The task ends `failed` with the failure that began the saga either way. The
          // rollback outcome is derived from what ran, and stored nowhere.
          if (next.kind === 'halt') {
            await store.failRollback(queue, runId, claimToken, causeJson, null, next.failed)
          } else {
            await store.fail(queue, runId, claimToken, causeJson, null)
          }
        } catch (inner) {
          return trustedStoreOutcome(inner)
        }
        return next.kind === 'halt' ? { kind: 'rollback-failed' } : { kind: 'rolled-back' }
      }
    }

    let resultJson: string
    try {
      let params: unknown
      try {
        params = parseTaskValueJson(run.paramsJson)
      } catch {
        params = run.paramsJson // legacy/opaque payloads pass through as text
      }
      const saga = ctx.rollingBack
      if (saga !== undefined) return await rollBack(params, saga.causeJson)
      const result = await handler(ctx, params)
      // A task that caught the error which ended its pass, and went on to return, has not
      // finished: what it returned was decided after its run was told it could not go on.
      const ended = infrastructureOutcome(taskControls.snapshot(endedBy(ctx)))
      if (ended !== undefined) return ended
      resultJson = serializeTaskValue('task result', result)
    } catch (error) {
      const control = taskControls.snapshot(error)
      // awaitEvent parks the run INSIDE its own atomic batch — a second park
      // here would overwrite the registered wait.
      if (control?.kind === 'await-event') return { kind: 'suspended' }
      if (control?.kind === 'sleep') {
        try {
          // The park and its marker are ONE transition (or neither happens):
          // a marker without a park would lie on the next pass.
          await store.suspendRun(queue, runId, claimToken, control.wake, control.checkpoint)
          return { kind: 'suspended' }
        } catch (inner) {
          return trustedStoreOutcome(inner)
        }
      }
      // An invocation-authenticated infrastructure control (a lost lease, or a
      // store outage crossing the context boundary): abort with no additional
      // transition — the lease story recovers and the user's retry budget is
      // untouched.
      const infrastructure = infrastructureOutcome(control)
      if (infrastructure !== undefined) return infrastructure

      // A user failure: core decides retry over the USER ordinal.
      return await recordUserFailure(error)
    }

    // The completion write is lexically outside the user-failure classifier:
    // an ordinary rejection must propagate, while authenticated store control
    // still maps to the worker's infrastructure outcomes.
    try {
      await store.complete(queue, runId, claimToken, resultJson)
    } catch (error) {
      return trustedStoreOutcome(error)
    }
    return { kind: 'completed' }
  } finally {
    abortControllerAbort(pumpStop)
    // Bounded finalization: a heartbeat call that never settles must not
    // retain this pass (and its HTTP request) forever after the run's
    // transition already committed.
    const finalizationStop = new TaskAbortController()
    try {
      await trustedPromiseRace(pump, clock.sleep(5_000, abortControllerSignal(finalizationStop)))
    } finally {
      abortControllerAbort(finalizationStop)
    }
  }
}

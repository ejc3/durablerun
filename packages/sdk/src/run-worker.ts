import {
  type Clock,
  type SchedulerStore,
  decideRetry,
  parseTaskValueJson,
  serializeTaskValue,
  snapshotTaskThrowable,
} from '@durablerun/core'
import { ReplayContext, type TaskContext } from './context.js'
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
  type InfrastructureControlSnapshot,
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
  | { kind: 'superseded' } // duplicate delivery / stale claim: did nothing
  | { kind: 'lease-lost' } // lost the lease mid-run: aborted quietly
  | { kind: 'cancelled' } // the task was cancelled mid-run (AB001): aborted quietly
  | { kind: 'aborted' } // store unreachable mid-pass: user budget untouched
  //   and the lease story recovers. NOTE: 'unreachable' includes a lost
  //   RESPONSE — the write may or may not have committed; recovery is
  //   correct either way (fences + sweep), but do not read 'aborted' as
  //   proof that nothing changed.
  | { kind: 'deferred' } // unknown task name: parked untouched for a
//                        worker build that knows it (rolling deploys)

export interface RunInvocation {
  queue: string
  runId: string
  claimToken: string
  claimGen: number
}

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
  control: InfrastructureControlSnapshot | undefined,
): WorkerOutcome | undefined {
  if (control === undefined) return undefined
  switch (control.kind) {
    case 'lease-lost':
      return { kind: 'lease-lost' }
    case 'run-cancelled':
      return { kind: 'cancelled' }
    case 'store-unavailable':
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
 * 1. A launched task name this build does not know is DEFERRED from the
 *    launch, before activation (parked ~15s with its carried wake preserved,
 *    nothing consumed, the first start never latched) — deploy workers before
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
    // Rolling-deploy rule: defer from the launch, BEFORE activation, so a build
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

  const run = await store.activate(queue, runId, claimToken, claimGen)
  if (run === null) return { kind: 'superseded' }
  const claimedRun = run
  const userAttempt = claimedRun.attempt - claimedRun.infraRetries

  // Heartbeat pump FIRST (before any further unfenced reads): extend at
  // half-lease cadence until the pass ends. A zero-row heartbeat is the
  // lease-lost signal — the fences already refuse a zombie's writes; the
  // leaseLost signal additionally stops the HANDLER at its next context
  // call, so a zombie stops burning side effects too.
  const pumpStop = new TaskAbortController()
  const pumpStopSignal = abortControllerSignal(pumpStop)
  const leaseLost = new TaskAbortController()
  const leaseLostSignal = abortControllerSignal(leaseLost)
  const leaseMs = run.leaseSeconds * 1000
  const pump = (async () => {
    for (;;) {
      await clock.sleep(leaseMs / 2, pumpStopSignal)
      if (abortSignalAborted(pumpStopSignal)) return
      try {
        const lease = await store.heartbeat(queue, runId, claimToken, run.leaseSeconds)
        if (!lease.held) {
          abortControllerAbort(leaseLost)
          return
        }
      } catch {
        return // heartbeat is advisory upkeep; the fences are the truth
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
      leaseLostSignal,
      taskControls.issuer,
      userAttempt,
    )

    async function recordUserFailure(error: unknown): Promise<WorkerOutcome> {
      const thrown = snapshotTaskThrowable(error)
      const decision = thrown.fatal
        ? ({ retry: false } as const)
        : decideRetry(claimedRun.retryStrategy, userAttempt, claimedRun.maxAttempts)
      try {
        await store.fail(
          queue,
          runId,
          claimToken,
          thrown.failureJson,
          decision.retry ? { delaySeconds: decision.delaySeconds } : null,
        )
      } catch (inner) {
        return trustedStoreOutcome(inner)
      }
      return decision.retry ? { kind: 'retry-scheduled' } : { kind: 'failed' }
    }

    let resultJson: string
    try {
      let params: unknown
      try {
        params = parseTaskValueJson(run.paramsJson)
      } catch {
        params = run.paramsJson // legacy/opaque payloads pass through as text
      }
      const result = await handler(ctx, params)
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

import {
  type Clock,
  decideRetry,
  FatalTaskError,
  LeaseLostError,
  type SchedulerStore,
  serializeTaskValue,
  StoreUnavailableError,
  SuspendSignal,
} from '@durablerun/core'
import { ReplayContext, type TaskContext } from './context.js'

/** A registered durable task function. Params arrive parsed from JSON. */
export type TaskHandler = (ctx: TaskContext, params: unknown) => Promise<unknown>
export type TaskRegistry = ReadonlyMap<string, TaskHandler>

/** What one worker invocation did with its run (DESIGN.md §3.2). */
export type WorkerOutcome =
  | { kind: 'completed' }
  | { kind: 'suspended' } // sleep/await: parked, will wake later
  | { kind: 'retry-scheduled' } // user failure with retries left
  | { kind: 'failed' } // user failure, terminal
  | { kind: 'superseded' } // duplicate delivery / stale claim: did nothing
  | { kind: 'lease-lost' } // lost the lease mid-run: aborted quietly
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
 * The infrastructure-failure classification, in ONE place: a lost lease and
 * a store outage each abort the pass without spending the user's budget,
 * and every transition write (complete, suspend, fail, the rolling-deploy
 * defer) must treat them identically. Returns undefined for anything else —
 * a genuine user failure — so the caller rethrows or classifies it. Two of
 * the five call sites once open-coded this and silently dropped the outage
 * arm, rethrowing raw; a single definition makes that divergence unwritable.
 */
function infraOutcome(error: unknown): WorkerOutcome | undefined {
  if (error instanceof LeaseLostError) return { kind: 'lease-lost' }
  if (error instanceof StoreUnavailableError) return { kind: 'aborted' }
  return undefined
}

/** A throw as an expression, so `infraOutcome(e) ?? raise(e)` reads inline. */
function raise(error: unknown): never {
  throw error
}

/**
 * Execute one claimed run to its next suspension point or terminal state.
 * Transport-free: the HTTP worker server (driver package) wraps this; tests
 * call it directly. The contract, in order:
 *
 * 1. Activation is the gate: the per-claim compare-and-swap admits exactly
 *    one invocation per claim — a duplicate delivery, a superseded claim,
 *    or a swept lease all exit here having touched nothing.
 * 2. A task name this build does not know is DEFERRED (parked ~15s with
 *    its carried wake preserved, nothing consumed) — deploy workers before
 *    producers and old runs survive new code.
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

  const run = await store.activate(queue, runId, claimToken, claimGen)
  if (run === null) return { kind: 'superseded' }

  const handler = registry.get(run.taskName)
  if (handler === undefined) {
    // Rolling-deploy rule: defer, consume nothing. The jitter is derived
    // from the run id (no ambient randomness in engine code) so a fleet of
    // stale workers spreads its retries instead of thundering.
    const jitterSeconds = [...run.runId].reduce((a, c) => a + c.charCodeAt(0), 0) % 10
    try {
      await store.reschedule(
        queue,
        runId,
        claimToken,
        { inSeconds: 15 + jitterSeconds },
        'preserve',
      )
    } catch (error) {
      return infraOutcome(error) ?? raise(error)
    }
    return { kind: 'deferred' }
  }

  // Heartbeat pump FIRST (before any further unfenced reads): extend at
  // half-lease cadence until the pass ends. A zero-row heartbeat is the
  // lease-lost signal — the fences already refuse a zombie's writes; the
  // leaseLost signal additionally stops the HANDLER at its next context
  // call, so a zombie stops burning side effects too.
  const pumpStop = new AbortController()
  const leaseLost = new AbortController()
  const leaseMs = Math.max(1000, run.leaseSeconds * 1000)
  const pump = (async () => {
    for (;;) {
      await clock.sleep(leaseMs / 2, pumpStop.signal)
      if (pumpStop.signal.aborted) return
      try {
        const lease = await store.heartbeat(queue, runId, claimToken, run.leaseSeconds)
        if (!lease.held) {
          leaseLost.abort()
          return
        }
      } catch {
        return // heartbeat is advisory upkeep; the fences are the truth
      }
    }
  })()

  let checkpoints: Awaited<ReturnType<SchedulerStore['getCheckpoints']>>
  try {
    checkpoints = await store.getCheckpoints(queue, run.taskId, run.attempt)
  } catch (error) {
    pumpStop.abort()
    await pump
    return infraOutcome(error) ?? raise(error)
  }
  const ctx = new ReplayContext(store, queue, run, checkpoints, leaseLost.signal)

  try {
    let params: unknown
    try {
      params = JSON.parse(run.paramsJson)
    } catch {
      params = run.paramsJson // legacy/opaque payloads pass through as text
    }
    const result = await handler(ctx, params)
    // The completion write sits OUTSIDE the user-failure classification: a
    // transient store error here is infrastructure, and billing it as a
    // user failure would terminally fail a task whose handler succeeded.
    try {
      await store.complete(queue, runId, claimToken, serializeTaskValue('task result', result))
    } catch (inner) {
      return infraOutcome(inner) ?? raise(inner)
    }
    return { kind: 'completed' }
  } catch (error) {
    if (error instanceof SuspendSignal) {
      // awaitEvent parks the run INSIDE its own atomic batch — a second
      // park here would overwrite the registered wait.
      if (error.reason === 'await-event') return { kind: 'suspended' }
      try {
        // The park and its marker are ONE transition (or neither happens):
        // a marker without a park would lie on the next pass.
        if (error.checkpoint) {
          await store.suspendRun(queue, runId, claimToken, error.wake ?? { inSeconds: 0 }, {
            key: error.checkpoint.key,
            stateJson: error.checkpoint.stateJson,
          })
        } else {
          await store.reschedule(queue, runId, claimToken, error.wake ?? { inSeconds: 0 })
        }
        return { kind: 'suspended' }
      } catch (inner) {
        return infraOutcome(inner) ?? raise(inner)
      }
    }
    // Infrastructure failure by TYPE (a lost lease, or a store outage inside
    // a step arriving here through user code): abort with no transition —
    // the lease story recovers and the user's retry budget is untouched.
    const infra = infraOutcome(error)
    if (infra) return infra

    // A user failure: core decides retry over the USER ordinal.
    const userAttempt = ctx.attempt
    const decision =
      error instanceof FatalTaskError
        ? ({ retry: false } as const)
        : decideRetry(run.retryStrategy, userAttempt, run.maxAttempts)
    const failureJson = JSON.stringify({
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      await store.fail(
        queue,
        runId,
        claimToken,
        failureJson,
        decision.retry ? { delaySeconds: decision.delaySeconds } : null,
      )
    } catch (inner) {
      return infraOutcome(inner) ?? raise(inner)
    }
    return decision.retry ? { kind: 'retry-scheduled' } : { kind: 'failed' }
  } finally {
    pumpStop.abort()
    // Bounded finalization: a heartbeat call that never settles must not
    // retain this pass (and its HTTP request) forever after the run's
    // transition already committed.
    await Promise.race([pump, clock.sleep(5_000)])
  }
}

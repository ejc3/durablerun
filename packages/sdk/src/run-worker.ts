import {
  type Clock,
  decideRetry,
  FatalTaskError,
  LeaseLostError,
  RunCancelledError,
  type SchedulerStore,
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
  | { kind: 'cancelled' } // the run was cancelled out from under us
  | { kind: 'deferred' } // unknown task name: parked untouched for a
//                        worker build that knows it (rolling deploys)

export interface RunInvocation {
  queue: string
  runId: string
  claimToken: string
  claimGen: number
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
      if (error instanceof LeaseLostError) return { kind: 'lease-lost' }
      throw error
    }
    return { kind: 'deferred' }
  }

  const checkpoints = await store.getCheckpoints(queue, run.taskId, run.attempt)
  const ctx = new ReplayContext(store, queue, run, checkpoints)

  // Heartbeat pump: extend at half-lease cadence until the pass ends. A
  // zero-row heartbeat is the lease-lost signal — stop pumping; the fenced
  // store writes will refuse the zombie's next commit on their own.
  const pumpStop = new AbortController()
  const leaseMs = Math.max(1000, run.leaseSeconds * 1000)
  const pump = (async () => {
    for (;;) {
      await clock.sleep(leaseMs / 2, pumpStop.signal)
      if (pumpStop.signal.aborted) return
      try {
        const lease = await store.heartbeat(queue, runId, claimToken, run.leaseSeconds)
        if (!lease.held) return
      } catch {
        return // heartbeat is advisory upkeep; the fences are the truth
      }
    }
  })()

  try {
    let params: unknown
    try {
      params = JSON.parse(run.paramsJson)
    } catch {
      params = run.paramsJson // legacy/opaque payloads pass through as text
    }
    const result = await handler(ctx, params)
    await store.complete(queue, runId, claimToken, JSON.stringify(result ?? null))
    return { kind: 'completed' }
  } catch (error) {
    if (error instanceof SuspendSignal) {
      try {
        await store.reschedule(queue, runId, claimToken, error.wake ?? { inSeconds: 0 })
        return { kind: 'suspended' }
      } catch (inner) {
        if (inner instanceof LeaseLostError) return { kind: 'lease-lost' }
        throw inner
      }
    }
    if (error instanceof LeaseLostError) return { kind: 'lease-lost' }
    if (error instanceof RunCancelledError) return { kind: 'cancelled' }

    // A user failure: core decides retry over the USER ordinal.
    const userAttempt = run.attempt - run.infraRetries
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
      if (inner instanceof LeaseLostError) return { kind: 'lease-lost' }
      throw inner
    }
    return decision.retry ? { kind: 'retry-scheduled' } : { kind: 'failed' }
  } finally {
    pumpStop.abort()
    await pump
  }
}

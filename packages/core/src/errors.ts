/**
 * Engine error taxonomy, ported from Absurd's custom SQLSTATEs and internal
 * SDK exceptions (DESIGN.md §1.2): AB001 → RunCancelledError, AB002 →
 * LeaseLostError; SuspendSignal is the internal control-flow signal thrown by
 * ctx.sleepFor / ctx.awaitEvent and caught by the worker runtime.
 */

export class SuspendSignal extends Error {
  override readonly name = 'SuspendSignal'
  constructor(readonly reason: 'sleep' | 'await-event' | 'chain') {
    super(`run suspended: ${reason}`)
  }
}

/** The run was cancelled (Absurd AB001); abort the handler quietly. */
export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError'
}

/**
 * The lease is gone — swept, superseded, or expired (Absurd AB002). The
 * worker must abort immediately; another claim now owns the run.
 */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError'
}

/** Worker-thrown: permanent failure, skip retries (maps to Absurd FatalError). */
export class FatalTaskError extends Error {
  override readonly name = 'FatalTaskError'
}

/**
 * An awaitEvent timeout fired: the claim delivered `wakeEvent` with a NULL
 * payload (§3.4 rule 2's TimeoutError path). Raised into user code by the SDK.
 */
export class EventTimeoutError extends Error {
  override readonly name = 'EventTimeoutError'
  constructor(readonly eventName: string) {
    super(`timed out waiting for event '${eventName}'`)
  }
}

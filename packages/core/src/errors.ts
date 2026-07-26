/**
 * Engine error taxonomy, ported from Absurd's custom SQLSTATEs and internal
 * SDK exceptions (DESIGN.md §1.2): AB001 → RunCancelledError, AB002 →
 * LeaseLostError; SuspendSignal is the internal control-flow signal thrown by
 * ctx.sleepFor / ctx.awaitEvent and caught by the worker runtime.
 */

export class SuspendSignal extends Error {
  override readonly name = 'SuspendSignal'
  constructor(
    readonly reason: 'sleep' | 'await-event' | 'chain',
    /** Where the runtime should park the run (relative, or the sanctioned
     * user absolute). Omitted for 'chain' (wake immediately). */
    readonly wake?: { inSeconds: number } | { atEpochMs: number },
    /**
     * The suspension marker, written IN THE SAME transition as the park —
     * a marker without a park lies ("the wake already happened"), so the
     * two must be one atomic batch (store.suspendRun).
     */
    readonly checkpoint?: { key: string; stateJson: string },
  ) {
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

/**
 * The store could not be reached or the write did not go through — a
 * TRANSIENT infrastructure failure (network, busy database). Consumers
 * classify by this TYPE: infrastructure problems abort a pass quietly and
 * recover through the lease, and must never spend the user's retry budget.
 */
export class StoreUnavailableError extends Error {
  override readonly name = 'StoreUnavailableError'
}

/**
 * The database's schema is not the one this build expects — a missing table
 * or column. DELIBERATELY NOT a StoreUnavailableError: it is permanent, and
 * waiting does not repair it.
 *
 * That distinction is the whole point of the type. Consumers classify
 * infrastructure trouble by type and respond by aborting the pass and
 * recovering through the lease, which for a schema mismatch means retrying a
 * deterministic failure until the run's infrastructure budget is gone — the
 * task then dies reporting exhausted infrastructure and the real cause (an
 * un-migrated database, most often mid-deploy) is recorded nowhere. Naming
 * the fault separately makes that outcome unreachable rather than merely
 * unlikely.
 */
export class SchemaMismatchError extends Error {
  override readonly name = 'SchemaMismatchError'
}

/**
 * The schema metadata relation does not exist yet, so migration may initialize
 * a genuinely fresh database. Dialect executors emit this only for the
 * canonical schema-version read; StoreAdmin must never infer it from text.
 */
export class SchemaNotInitializedError extends Error {
  override readonly name = 'SchemaNotInitializedError'
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

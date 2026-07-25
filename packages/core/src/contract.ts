/**
 * Contract constants: values every dialect must agree on.
 *
 * These are spec, not tuning knobs — DESIGN.md pins them (sections 3.1 and
 * 3.8.2) and the conformance suite asserts behaviour at their boundaries, so
 * a SQLite, MySQL or Postgres store that disagrees fails the same suite. They
 * live here, in the dialect-neutral layer, for exactly that reason: a
 * constant defined inside one backend is a constant the other backends can
 * drift from silently.
 */

/**
 * How many times a run whose launch never arrived may be reopened before the
 * task is failed outright. A broken launcher has to surface as failed work
 * rather than an endless relaunch loop.
 */
export const RELAUNCH_CAP = 5

/**
 * How many times a run that died mid-flight may be replaced by an
 * infrastructure successor. Separate from the user-visible attempt budget:
 * infrastructure failures must not consume the retries the caller asked for.
 */
export const INFRA_RETRY_CAP = 20

/** Delay before an infrastructure successor becomes available. */
export const INFRA_BACKOFF_SECONDS = 5

/** Linear backoff on the relaunch counter: base * count, clamped to max. */
export const RELAUNCH_BACKOFF_BASE_SECONDS = 5
export const RELAUNCH_BACKOFF_MAX_SECONDS = 60

/**
 * Terminal failure reasons written by the engine itself, as stored JSON.
 * Wire-visible contract values shared with the conformance suite. They are
 * pure data — ownership of a transition is proved by a batch's stamp, never
 * by a reason string.
 */
export const REASON_CLAIM_TIMEOUT = '{"name":"$ClaimTimeout"}'
export const REASON_RELAUNCH_CAP = '{"name":"$RelaunchCapExhausted"}'
export const REASON_INFRA_CAP = '{"name":"$InfraRetriesExhausted"}'

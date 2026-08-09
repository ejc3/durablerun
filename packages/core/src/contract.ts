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
export const REASON_CANCELLED = '{"name":"$Cancelled"}'

/**
 * The tables that carry write provenance (§3.4 rule 8): every one of them is
 * the target of some compare-and-set, and each must have `fence_stamp TEXT`
 * and `fence_at_ms INTEGER`. This list is the CONTRACT — every dialect
 * generates its own migration from it, and `FencedBatch` accepts it as the
 * only legal CAS target, so a CAS against a table with nowhere to record
 * provenance does not compile.
 *
 * checkpoints, drivers and meta are absent because nothing compare-and-sets
 * them: checkpoints are lease-fenced by the worker's claim token (rule 5),
 * drivers are advisory, meta is configuration.
 */
export const FENCED_TABLES = ['tasks', 'runs', 'waits', 'events'] as const
export type FenceTable = (typeof FENCED_TABLES)[number]

/** One grammar for statement names embedded in persisted provenance stamps. */
export const FENCE_STATEMENT_NAME_SOURCE = String.raw`[a-zA-Z0-9_-]+`
const FENCE_STATEMENT_NAME = new RegExp(`^${FENCE_STATEMENT_NAME_SOURCE}$`)

export function isFenceStatementName(value: string): boolean {
  return FENCE_STATEMENT_NAME.test(value)
}

export type FenceStampParseResult =
  | { ok: true; seed: string; statement: string }
  | {
      ok: false
      reason: 'no-separator' | 'empty-seed' | 'empty-statement' | 'statement-name-invalid'
    }

/**
 * Parse the persisted `<batch-seed>:<statement-name>` representation.
 *
 * The seed may itself contain colons, so the statement is split at the final
 * separator. Keeping this parser beside the statement-name grammar gives
 * invariant checking and poison severity one canonical interpretation.
 */
export function parseFenceStamp(stamp: string): FenceStampParseResult {
  const separator = stamp.lastIndexOf(':')
  if (separator < 0) return { ok: false, reason: 'no-separator' }
  if (separator === 0) return { ok: false, reason: 'empty-seed' }
  if (separator === stamp.length - 1) return { ok: false, reason: 'empty-statement' }
  const statement = stamp.slice(separator + 1)
  if (!isFenceStatementName(statement)) {
    return { ok: false, reason: 'statement-name-invalid' }
  }
  return { ok: true, seed: stamp.slice(0, separator), statement }
}

/**
 * The logical-key relations a generated follow-on may traverse.
 *
 * Both sides live in this one contract entry deliberately. Letting a caller
 * spell `target.key` and `source.column` independently admits statements such
 * as `runs.run_id IN (SELECT runs.task_id ...)`: valid SQL, fully fenced, and
 * silently incapable of matching the row the transition means to update.
 *
 * The values are frozen as well as readonly so a JavaScript caller cannot
 * mutate the relation behind the TypeScript boundary at runtime.
 */
export const FENCE_RELATIONS = Object.freeze({
  'runs-to-tasks': Object.freeze({
    target: 'tasks',
    key: 'task_id',
    from: 'runs',
    column: 'task_id',
    queueScoped: true,
  }),
  'runs-to-waits': Object.freeze({
    target: 'waits',
    key: 'run_id',
    from: 'runs',
    column: 'run_id',
    // A run is authoritative for cleaning up every wait that names it. The
    // wait's queue is a denormalized witness and may itself be the corruption
    // the terminal transition must remove.
    queueScoped: false,
  }),
  'tasks-to-runs': Object.freeze({
    target: 'runs',
    key: 'task_id',
    from: 'tasks',
    column: 'task_id',
    queueScoped: true,
  }),
  'waits-to-runs': Object.freeze({
    target: 'runs',
    key: 'run_id',
    from: 'waits',
    column: 'run_id',
    queueScoped: true,
  }),
  'runs-to-runs': Object.freeze({
    target: 'runs',
    key: 'run_id',
    from: 'runs',
    column: 'run_id',
    queueScoped: false,
  }),
} as const)

export type FenceRelation = keyof typeof FENCE_RELATIONS

/** Relations on which sealing overwrites the source row itself. */
export type SelfFenceRelation = {
  [R in FenceRelation]: (typeof FENCE_RELATIONS)[R]['from'] extends (typeof FENCE_RELATIONS)[R]['target']
    ? (typeof FENCE_RELATIONS)[R]['target'] extends (typeof FENCE_RELATIONS)[R]['from']
      ? (typeof FENCE_RELATIONS)[R]['key'] extends (typeof FENCE_RELATIONS)[R]['column']
        ? (typeof FENCE_RELATIONS)[R]['column'] extends (typeof FENCE_RELATIONS)[R]['key']
          ? R
          : never
        : never
      : never
    : never
}[FenceRelation]

/**
 * Assignment targets accepted by generated follow-ons. The primitive writes
 * the left-hand side from this closed contract and callers supply only scalar
 * expressions, so provenance columns cannot be named through dialect quoting
 * tricks or duplicate assignments.
 */
export const DERIVED_WRITABLE_COLUMNS = Object.freeze({
  tasks: Object.freeze([
    'state',
    'last_attempt_run',
    'first_started_at_ms',
    'cancel_at_ms',
    'failure_reason',
    'infra_retries',
    'completed_payload',
    'attempts',
  ] as const),
  runs: Object.freeze([
    'state',
    'claimed_by',
    'claim_expires_at_ms',
    'available_at_ms',
    'wake_event',
    'event_payload',
    'wake_step',
    'heartbeat_at_ms',
  ] as const),
  waits: Object.freeze([] as const),
  events: Object.freeze([] as const),
} as const satisfies Record<FenceTable, readonly string[]>)

export type DerivedWritableColumn<T extends FenceTable> =
  (typeof DERIVED_WRITABLE_COLUMNS)[T][number]

/**
 * Conflict updates for first-write-wins facts re-stamp provenance without
 * moving the fact's original instant. This enumeration is shared by every
 * dialect; callers choose a target, never an arbitrary SQL expression.
 */
export const PRESERVED_FENCE_INSTANTS = {
  events: 'emitted_at_ms',
} as const satisfies Partial<Record<FenceTable, string>>
export type PreservedFenceTable = keyof typeof PRESERVED_FENCE_INSTANTS

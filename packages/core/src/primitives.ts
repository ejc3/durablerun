/**
 * The three primitives everything is built on (BUILD.md Phase 1 rule).
 *
 * All engine I/O flows through `SqlExecutor.batch()`; all ids/tokens come
 * from `IdSource`; all time is database time (shard-meta `fake_now`
 * override under test). The simulation harness gets deterministic
 * interleaving, crash injection, and duplication by wrapping these — engine
 * code never needs to know it is being simulated.
 */

export interface SqlStatement {
  readonly sql: string
  readonly args: ReadonlyArray<string | number | bigint | Uint8Array | null>
  /**
   * The index, in this batch, of the statement whose stamp gates this one. Seeds are
   * unique to an invocation, so when that statement wrote no row, no row carries its
   * stamp and this statement matches nothing. An executor that pays a round trip for
   * each statement may skip it then and answer with no rows. An executor that sends
   * the batch whole ignores this. A skipped statement and an executed one leave the
   * same state on a first delivery. On an exact replay the gating statement writes
   * nothing, and the skip leaves alone what the first delivery already committed.
   */
  readonly skipUnlessWrote?: number
}

export interface SqlRow {
  [column: string]: string | number | bigint | Uint8Array | null
}

export interface SqlResult {
  rows: SqlRow[]
  /**
   * Normalized contract (backends diverge natively): for row-returning
   * statements (SELECT, DML…RETURNING) this is rows.length; for plain DML it
   * is the affected-row count. Fence checks on RETURNING statements must
   * therefore read rows.length — which this normalization makes equivalent.
   */
  rowsAffected: number
}

/**
 * The single I/O primitive. A batch executes atomically (all-or-nothing) and
 * sequentially; statements see the effects of earlier statements in the same
 * batch — which is why fences key on the POST-transition state (§3.4 rule 1).
 *
 * `label` names the engine transition (e.g. `claim`, `sweep:claim-timeout`,
 * `checkpoint`) — the address space for crash injection and tracing.
 *
 * `mode` defaults to 'write' (atomic write transaction). Advisory reads —
 * idle polls, nextWakeAt, sweep candidate SELECTs — pass 'read' so they never
 * take the single-writer lock (§3.1's read-cheap idle-cost claim) and can be
 * served by replicas.
 */
export type SqlBatchMode = 'read' | 'write'

/**
 * A closed transaction prelude for dialects whose ordinary write batches do
 * not serialize event delivery against wait registration or concurrent claim
 * retries carrying the same durable receipt token.
 *
 * This is deliberately control data, not a `SqlStatement`: the executor owns
 * the dialect SQL that acquires the lock, executes it before every supplied
 * statement in the same transaction, and returns no result slot for it.
 * Callers therefore cannot smuggle an unfenced write into a FencedBatch under
 * the name "lock". Matching coordinates of the same kind must be mutually
 * exclusive until the transaction commits or rolls back.
 * Coordinate values are data and must be bound, never spliced into lock SQL.
 */
export type SqlTransactionLock =
  | {
      readonly kind: 'event'
      readonly queue: string
      readonly eventName: string
    }
  | {
      readonly kind: 'claim'
      readonly queue: string
      readonly claimToken: string
    }

export type SqlClaimLockCoordinates = Omit<
  Extract<SqlTransactionLock, { readonly kind: 'claim' }>,
  'kind'
>

/**
 * The lock travels in the existing batch-control position so every executor
 * wrapper forwards mode and lock as one value. A separate optional argument
 * is unsafe here: an otherwise correct wrapper can forward the first three
 * arguments, silently discard the lock, and reopen the protocol race.
 */
export interface SqlLockedBatch {
  readonly mode: 'write'
  readonly transactionLock: SqlTransactionLock
}

export type SqlBatchControl = SqlBatchMode | SqlLockedBatch

export function sqlBatchMode(control: SqlBatchControl | undefined): SqlBatchMode {
  if (control === undefined) return 'write'
  return typeof control === 'string' ? control : control.mode
}

export function sqlTransactionLock(
  control: SqlBatchControl | undefined,
): SqlTransactionLock | undefined {
  return typeof control === 'object' ? control.transactionLock : undefined
}

export interface SqlExecutor {
  batch(
    label: string,
    statements: readonly SqlStatement[],
    control?: SqlBatchControl,
  ): Promise<SqlResult[]>
}

/** All identifiers are injected so simulations are replayable by seed. */
export interface IdSource {
  /** Time-ordered UUIDv7 (ordering matters: run rows sort by id as tiebreak). */
  uuidv7(): string
  /** Opaque unique token (claim tokens, spawn tokens). */
  token(): string
}

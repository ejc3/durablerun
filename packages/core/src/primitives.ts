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
  sql: string
  args: ReadonlyArray<string | number | bigint | Uint8Array | null>
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

export interface SqlExecutor {
  batch(
    label: string,
    statements: readonly SqlStatement[],
    mode?: SqlBatchMode,
  ): Promise<SqlResult[]>
}

/** All identifiers are injected so simulations are replayable by seed. */
export interface IdSource {
  /** Time-ordered UUIDv7 (ordering matters: run rows sort by id as tiebreak). */
  uuidv7(): string
  /** Opaque unique token (claim tokens, spawn tokens). */
  token(): string
}

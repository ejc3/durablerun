import {
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlBatchControl,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  StoreUnavailableError,
  sqlBatchMode,
} from '@durablerun/core'
import { type Client, LibsqlError, createClient } from '@libsql/client'
import { SCHEMA_VERSION_READ_SQL } from './schema.js'

/**
 * SQLite's wording for "this build and this database disagree about the
 * shape of the data". All three are deterministic: the same statement will
 * fail the same way forever, so retrying is always wrong.
 */
const SCHEMA_FAULT = /no such (?:column|table)|has no column named|duplicate column name/i
const MISSING_META_TABLE = /no such table:\s*meta$/i

/**
 * SqlExecutor over @libsql/client. `batch(…, 'write')` is atomic — implicit
 * BEGIN IMMEDIATE, full rollback on any failure — which is the entire
 * transactional model this engine is allowed to use on Turso (no interactive
 * transactions; DESIGN.md §1.3). 'read' batches never take the writer lock.
 * The label is a tracing/crash-injection address for harness wrappers; the
 * real executor ignores it.
 *
 * Normalizations (backend contract tests pin these, per the standing rule —
 * backend divergence gets caught at the primitive, not in engine logic):
 * - rowsAffected: the local client hardcodes 0 for DML…RETURNING while the
 *   remote hrana path reports the real count — normalized to rows.length for
 *   any row-returning statement, so fence checks read one consistent value.
 * - Blobs arrive as ArrayBuffer (local wraps Buffer.buffer) — normalized to
 *   the Uint8Array the SqlRow contract promises.
 */
export class LibsqlExecutor implements SqlExecutor {
  private pragmas: Promise<void> | null = null

  constructor(
    private readonly client: Client,
    private readonly fileBacked = false,
  ) {}

  static open(url: string, authToken?: string): LibsqlExecutor {
    const fileBacked = url.startsWith('file:') && !url.includes(':memory:')
    return new LibsqlExecutor(createClient(authToken ? { url, authToken } : { url }), fileBacked)
  }

  /**
   * Multi-PROCESS operation on one database file needs write-ahead logging
   * (readers stop blocking the writer) and a busy timeout (a locked write
   * waits instead of failing) — per connection. PRAGMAs cannot run inside
   * a transaction, so this happens once, outside batch(), lazily before
   * the first one.
   */
  private applyConnectionPragmas(): Promise<void> {
    this.pragmas ??= (async () => {
      await this.client.execute('PRAGMA journal_mode=WAL')
      await this.client.execute('PRAGMA busy_timeout=5000')
    })()
    return this.pragmas
  }

  async batch(
    _label: string,
    statements: readonly SqlStatement[],
    control: SqlBatchControl = 'write',
  ): Promise<SqlResult[]> {
    // A lock-bearing write remains an ordinary libSQL write batch: its single
    // writer already provides the mutual exclusion the explicit lock requests
    // from multi-writer dialects.
    const mode = sqlBatchMode(control)
    // An `undefined` bind is a programming error, not an outage. Letting it
    // reach the driver put its TypeError inside the catch below, where every
    // driver throw becomes StoreUnavailableError — so a deterministic bad
    // value was reported as infrastructure and retried until the
    // infrastructure budget ran out. Rejecting it HERE, outside the try,
    // keeps that misclassification unwritable for every value that crosses
    // this port, not only the ones a boundary validator happens to cover.
    for (const [i, s] of statements.entries()) {
      for (const [j, arg] of s.args.entries()) {
        if (arg === undefined) {
          throw new TypeError(
            `batch(${_label}) statement ${i} argument ${j} is undefined — bind null explicitly if that is what you mean`,
          )
        }
      }
    }
    let results: Awaited<ReturnType<Client['batch']>>
    try {
      if (this.fileBacked) await this.applyConnectionPragmas()
      results = await this.client.batch(
        statements.map((s) => ({ sql: s.sql, args: [...s.args] })),
        mode,
      )
    } catch (error) {
      const schemaVersionRead =
        _label === 'migrate:version' &&
        mode === 'read' &&
        statements.length === 1 &&
        statements[0]?.sql === SCHEMA_VERSION_READ_SQL &&
        statements[0].args.length === 0
      if (
        schemaVersionRead &&
        error instanceof LibsqlError &&
        MISSING_META_TABLE.test(error.message)
      ) {
        throw new SchemaNotInitializedError('schema metadata has not been initialized', {
          cause: error,
        })
      }
      // A schema mismatch is PERMANENT, so it gets its own type: consumers
      // treat StoreUnavailableError as transient and recover through the
      // lease, which for a missing column means retrying a deterministic
      // failure until the run's infrastructure budget is gone. Splitting it
      // out here covers every statement of every batch, including paths no
      // startup check would run.
      if (error instanceof LibsqlError && SCHEMA_FAULT.test(error.message)) {
        throw new SchemaMismatchError(
          `batch(${_label}) hit a schema this build does not expect — the database is probably not migrated: ${String(error)}`,
          { cause: error },
        )
      }
      // Typed so consumers can classify INFRASTRUCTURE failure by type —
      // a store outage must never be mistaken for a user failure.
      throw new StoreUnavailableError(`batch(${_label}) failed: ${String(error)}`, {
        cause: error,
      })
    }
    return results.map((r) => ({
      rows: r.rows.map((row) => {
        const out: Record<string, string | number | bigint | Uint8Array | null> = {}
        for (const col of r.columns) {
          const v = row[col]
          out[col] =
            v instanceof ArrayBuffer
              ? new Uint8Array(v)
              : v === undefined
                ? null
                : (v as string | number | bigint | Uint8Array | null)
        }
        return out
      }),
      rowsAffected: r.columns.length > 0 ? r.rows.length : r.rowsAffected,
    }))
  }

  close(): void {
    this.client.close()
  }
}

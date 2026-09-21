import {
  PermanentStoreError,
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
 * SQLite result codes that say the statement was refused for good, with these values: a
 * broken constraint, and a value of the wrong type for a column that enforces one. The same
 * batch fails the same way on every retry.
 *
 * SQLITE_ERROR is deliberately absent. SQLite files a syntax error under that generic code,
 * and files a transaction state error there too, which a new connection cures, and the code
 * is all this executor may read: it never reads message text to type an error. A code that
 * is not listed here is an outage.
 */
const PERMANENT_RESULT_CODES = new Set(['SQLITE_CONSTRAINT', 'SQLITE_MISMATCH'])

/**
 * The primary result code a driver error names. An extended code spells its primary code
 * first (SQLITE_CONSTRAINT_PRIMARYKEY, SQLITE_IOERR_SHORT_READ), and every primary code is
 * two words.
 */
function primaryResultCode(error: LibsqlError): string {
  return error.code.split('_').slice(0, 2).join('_')
}

/** What a settled turn keeps of the batch before it: nothing, so the queue holds no rows. */
const settled = (): void => {}

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
  /** Whether the connection in use has the two PRAGMAs a database file needs. */
  private pragmasApplied = false

  /**
   * Set by every failed batch of a database file, and cleared once the connection has
   * answered for itself and whatever it owed has been paid in full. A payment that fails
   * leaves it set, so the next call pays before its batch.
   */
  private suspect = false

  /** Set by close(). A closed executor is never given a new connection. */
  private closed = false

  /**
   * Settles when the last batch sent to a database file has been answered, failed or not,
   * and holds none of its rows.
   */
  private turn: Promise<void> = Promise.resolve()

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
   * (readers stop blocking the writer), which the file keeps once it is set,
   * and a busy timeout (a locked write waits instead of failing), which each
   * connection needs. PRAGMAs cannot run inside a transaction, so this happens
   * outside batch(), lazily before the first batch of every connection.
   *
   * After a failed batch the connection is first asked whether it is whole, and
   * replaced when it is not: a statement the client library cannot finish can be
   * left in progress on it, and it then fails every later batch at its COMMIT
   * (DESIGN.md §3.2). The client is closed before it reconnects. Its `reconnect()`
   * closes the old connection and then opens the new one, so an open that failed
   * would leave it holding a closed connection, and the native binding ends the
   * process when it reads such a connection's transaction state, which a failed
   * batch makes it do. Closed first, a client whose open failed refuses every call
   * itself, and the next call tries again. A closed executor is never reconnected,
   * which is checked after the question, because the caller may close the executor
   * while the question runs.
   */
  private async prepareConnection(): Promise<void> {
    if (!this.suspect && this.pragmasApplied) return
    if (this.suspect && !(await this.connectionIsWhole()) && !this.closed) {
      this.pragmasApplied = false
      this.client.close()
      await this.client.reconnect()
    }
    if (!this.pragmasApplied) {
      await this.client.executeMultiple('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
      this.pragmasApplied = true
    }
    this.suspect = false
  }

  /**
   * Asks the connection the question a COMMIT is asked. An empty read transaction commits
   * only when no writing statement is in progress and the connection is outside a
   * transaction, which are the two states that fail the batches after a failed one. So a
   * failure that left nothing behind, a broken constraint for one, keeps its connection.
   * It is sent as SQL text, which the native binding prepares, steps and finalizes inside
   * one call, so the question itself leaves no statement behind, whatever the answer.
   */
  private async connectionIsWhole(): Promise<boolean> {
    try {
      await this.client.executeMultiple('BEGIN TRANSACTION READONLY; COMMIT')
      return true
    } catch {
      return false
    }
  }

  async batch(
    _label: string,
    statements: readonly SqlStatement[],
    control: SqlBatchControl = 'write',
  ): Promise<SqlResult[]> {
    // A lock-bearing write remains an ordinary libSQL write batch: its single
    // writer already provides the mutual exclusion the explicit lock requests
    // from multi-writer dialects. That holds for a lock of every kind, a kind of
    // a later build included, because keeping two write batches apart is all a
    // lock asks. So this executor implements every kind by taking nothing, where
    // a server executor refuses a kind it does not know.
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
    // The one call that reaches the driver, written here inside batch(). On a database
    // file it runs in this batch's turn, and a failure marks the connection before the
    // next turn begins. Every error is typed below, in one place, whichever way it came.
    const send = async () => {
      try {
        if (this.fileBacked) await this.prepareConnection()
        return await this.client.batch(
          statements.map((s) => ({ sql: s.sql, args: [...s.args] })),
          mode,
        )
      } catch (error) {
        if (this.fileBacked) this.suspect = true
        throw error
      }
    }
    // A database file's batches run one at a time, each after the one before it has been
    // answered and has marked its connection if it failed. The local client runs a batch
    // without yielding, so two batches never overlapped and the queue loses nothing. Without
    // it, a batch already waiting when another fails would run on the connection that
    // failure broke, before the failed call's own error handling has run, and one outage
    // would be reported as two. A hosted client keeps its concurrent requests.
    const answer = this.fileBacked ? this.turn.then(send) : send()
    if (this.fileBacked) this.turn = answer.then(settled, settled)
    let results: Awaited<ReturnType<Client['batch']>>
    try {
      results = await answer
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
      // The store answered and no retry changes the answer. Typed apart from an outage,
      // by the driver's code, so a consumer can stop retrying a failure that is
      // deterministic.
      if (error instanceof LibsqlError && PERMANENT_RESULT_CODES.has(primaryResultCode(error))) {
        throw new PermanentStoreError(`batch(${_label}) failed permanently: ${String(error)}`, {
          cause: error,
        })
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
    this.closed = true
    this.client.close()
  }
}

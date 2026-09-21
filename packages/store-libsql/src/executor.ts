import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
 * An argument as it is at the call. A byte array is copied into a new Uint8Array, because a
 * caller can change one after the call, and a Buffer's own slice shares its memory; every
 * other argument is a string, a number, a bigint or null.
 */
const copied = (arg: SqlStatement['args'][number]) =>
  arg instanceof Uint8Array ? new Uint8Array(arg) : arg

/**
 * A file URL's path as the client stores it: percent-decoded as the client decodes it, and
 * relative when the URL's is. Undefined for every URL that names no database file: a hosted
 * one, `:memory:`, and an empty path, which SQLite makes a private database of its one
 * connection. The scheme is read case-insensitively, as the client reads it.
 */
function fileUrlPath(url: string): { path: string; absolute: boolean; rest: string } | undefined {
  const parts = /^file:(?<authority>\/\/[^/?#]*)?(?<path>[^?#]*)(?<rest>[?#].*)?$/is.exec(
    url,
  )?.groups
  if (parts === undefined) return undefined
  let path: string
  try {
    path = decodeURIComponent(parts.path ?? '')
  } catch {
    return undefined
  }
  if (path === '' || path.includes(':memory:')) return undefined
  return {
    path,
    absolute: parts.authority !== undefined || isAbsolute(path),
    rest: parts.rest ?? '',
  }
}

/**
 * The URL an executor opens a database FILE with, and the path its client stores and
 * reopens. A relative path is made absolute against the directory the process is in when the
 * executor opens, so a later change of directory does not move it.
 */
function databaseFile(url: string): { url: string; path: string } | undefined {
  const file = fileUrlPath(url)
  if (file === undefined) return undefined
  if (file.absolute) return { url, path: file.path }
  const path = resolve(file.path)
  return { url: `${pathToFileURL(path).href}${file.rest}`, path }
}

/**
 * A database file as the executor fixes it: the path the client reopens, the file that path
 * names with every symbolic link resolved, and that file's device and inode.
 */
export interface DatabaseFile {
  readonly path: string
  readonly real: string
  readonly device: bigint
  readonly inode: bigint
}

/**
 * The file a path names now, resolved against the directory the process is in now, as the
 * client's open resolves it, or undefined when nothing there can be read.
 */
export function fileAt(path: string): DatabaseFile | undefined {
  try {
    const real = realpathSync(resolve(path))
    const found = statSync(real, { bigint: true })
    return { path, real, device: found.dev, inode: found.ino }
  } catch {
    return undefined
  }
}

/** The same file, named by the same path. */
export function sameFile(had: DatabaseFile, now: DatabaseFile | undefined): boolean {
  return (
    now !== undefined &&
    now.path === had.path &&
    now.real === had.real &&
    now.device === had.device &&
    now.inode === had.inode
  )
}

/**
 * The file an executor fixes as its own, from the file its path named just before its client
 * opened it and just after. A path that named one file before the open and another after it
 * leaves no file the executor can be sure the client opened, so it fixes none.
 */
export function fixedFile(
  before: DatabaseFile | undefined,
  after: DatabaseFile | undefined,
): DatabaseFile | null {
  if (after === undefined) return null
  if (before !== undefined && !sameFile(before, after)) return null
  return after
}

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
   * The recovery has closed the client and not yet opened it again, so the client's closed
   * state is the recovery's and not its owner's. A client its owner closed is never reopened.
   */
  private reopening = false

  /**
   * This executor made its client, in open(), so no owner can close it: the client's closed
   * state is then this executor's own close's or the recovery's.
   */
  private ownsClient = false

  /**
   * The database file this executor fixed when it was made, or null when it has none it can be
   * sure of, and then it never reconnects. A new connection opens a path, and that path must
   * still name this file before the reopen and after it.
   */
  private file: DatabaseFile | null = null

  /**
   * Settles when the last batch sent to a database file has been answered, failed or not,
   * and holds none of its rows.
   */
  private turn: Promise<void> = Promise.resolve()

  /**
   * `databaseUrl` is the URL a file-backed client handed here was created with. From it the
   * executor fixes, now, the file that client opened. A file-backed executor made without it has
   * no file it can be sure of, and never reconnects.
   */
  constructor(
    private readonly client: Client,
    private readonly fileBacked = false,
    databaseUrl?: string,
  ) {
    const path = databaseUrl === undefined ? undefined : fileUrlPath(databaseUrl)?.path
    if (fileBacked && path !== undefined) this.file = fileAt(path) ?? null
  }

  static open(url: string, authToken?: string): LibsqlExecutor {
    const file = databaseFile(url)
    const opened = file?.url ?? url
    const before = file === undefined ? undefined : fileAt(file.path)
    const executor = new LibsqlExecutor(
      createClient(authToken ? { url: opened, authToken } : { url: opened }),
      file !== undefined,
    )
    executor.ownsClient = true
    if (file !== undefined) executor.file = fixedFile(before, fileAt(file.path))
    return executor
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
   * itself, and the next call tries again. A closed executor is never reconnected, and
   * neither is a client its owner closed, which is checked after the question, because
   * either can be closed while the question runs. A new connection must reach the file the executor had: the
   * path is checked before the reconnect and the new connection's file after it.
   */
  private async prepareConnection(): Promise<void> {
    if (!this.suspect && this.pragmasApplied) return
    if (this.suspect && !(await this.connectionIsWhole()) && !this.closedByItsOwner()) {
      const had = this.refuseToReopenAnotherFile()
      this.pragmasApplied = false
      this.reopening = true
      this.client.close()
      try {
        await this.client.reconnect()
      } finally {
        this.reopening = false
      }
      await this.refuseAnotherFileOpened(had)
    }
    if (!this.pragmasApplied) {
      await this.client.executeMultiple('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
      this.pragmasApplied = true
    }
    this.suspect = false
  }

  /**
   * Closed by close(), or, for a client handed to the constructor, by its owner. A client the
   * recovery closed while it reconnects is not closed by its owner. After a reconnect that
   * threw, a handed client's owner's close can no longer be told from the recovery's, so that
   * client is taken for closed by its owner and is never reopened.
   */
  private closedByItsOwner(): boolean {
    return this.closed || (!this.ownsClient && this.client.closed && !this.reopening)
  }

  /**
   * Refuses a reconnect that cannot reach the file this executor fixed. The client reopens its
   * path, whatever file that path names now, and creates one where none is: it offers no way to
   * open without creating. So the path is checked first, and a file that is gone or was
   * replaced, or a path that now leads elsewhere, is refused before anything is opened.
   */
  private refuseToReopenAnotherFile(): DatabaseFile {
    const had = this.file
    if (had === null) {
      throw new Error(
        'this executor fixed no database file when it was made, so it opens no new connection',
      )
    }
    if (!sameFile(had, fileAt(had.path))) {
      throw new Error(
        `the path ${had.path} no longer names the database file ${had.real} this executor opened, so no new connection is opened`,
      )
    }
    return had
  }

  /**
   * Refuses a new connection that did not open the file the executor fixed, before it serves a
   * batch: between the check above and the reopen, the path can come to name another file.
   * SQLite names the file the connection opened, with every symbolic link resolved, and the
   * path must still name that same file. A refused connection is closed, and the next call
   * tries again.
   */
  private async refuseAnotherFileOpened(had: DatabaseFile): Promise<void> {
    let opened = ''
    try {
      const listed = await this.client.execute('PRAGMA database_list')
      const main = listed.rows.find((row) => row.name === 'main')
      opened = typeof main?.file === 'string' ? main.file : ''
    } catch {
      opened = ''
    }
    if (opened !== had.real || !sameFile(had, fileAt(had.path))) {
      this.reopening = true
      this.client.close()
      throw new Error(
        `a new connection opened ${opened === '' ? 'no database file it could name' : opened}, which is not the database file ${had.real} this executor opened, so it is closed before it serves a batch`,
      )
    }
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
    // The statements as they are at the call, their argument arrays and byte arrays copied. A
    // database file's batch waits for its turn, and what a caller changes after the call must
    // change nothing that is sent.
    const sent = statements.map((s) => ({ sql: s.sql, args: s.args.map(copied) }))
    const send = async () => {
      try {
        if (this.fileBacked) await this.prepareConnection()
        return await this.client.batch(sent, mode)
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
        sent.length === 1 &&
        sent[0]?.sql === SCHEMA_VERSION_READ_SQL &&
        sent[0].args.length === 0
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

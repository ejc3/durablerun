import {
  InvalidDurableStringError,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlBatchControl,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  type SqlTransactionLock,
  StoreUnavailableError,
  sqlBatchMode,
  sqlTransactionLock,
} from '@durablerun/core'
import {
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  createPool,
} from 'mysql2/promise'
import { SCHEMA_VERSION_READ_SQL } from './schema.js'

/** mysql2 column type codes this executor normalizes. */
const TYPE_INTEGERS = new Set([1, 2, 3, 8, 9, 13])
const TYPE_BLOBS = new Set([249, 250, 251, 252])
const BINARY_CHARSET = 63

const ER_NO_SUCH_TABLE = 1146

/** MySQL errors that prove the installed relations differ from this build. */
const SCHEMA_MISMATCH_ERRNOS = new Set([
  1049, // ER_BAD_DB_ERROR
  1050, // ER_TABLE_EXISTS_ERROR
  1054, // ER_BAD_FIELD_ERROR
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
  ER_NO_SUCH_TABLE,
  1305, // ER_SP_DOES_NOT_EXIST
])
/**
 * A string is longer than its column. Only an indexed identifier is bounded here, at 255
 * characters, because MySQL cannot index unbounded text. It is invalid input and
 * permanent: reported as an outage it would be retried until a run's infrastructure
 * budget was gone.
 */
const ER_DATA_TOO_LONG = 1406

/** The note MySQL raises when it cuts a value to fit its column. */
const WARN_DATA_TRUNCATED = 1265

/** The handshake capability that makes MySQL report matched rows in place of changed ones. */
const CLIENT_FOUND_ROWS = 0x2

/** How long a batch waits for a named lock before the store reports itself unavailable. */
const LOCK_WAIT_SECONDS = 30

/**
 * One name for every migrator of a database. MySQL commits each DDL statement on its
 * own, so a migration batch is not atomic and a sentinel row cannot roll its DDL back.
 * The lock is what serializes migrators instead.
 */
const MIGRATION_LOCK = 'durablerun:migrate'

type PoolPort = Pick<Pool, 'getConnection' | 'end'>

class MysqlResultContractError extends TypeError {}

/**
 * Session settings every connection of the store runs under.
 *
 * - READ COMMITTED: the default, REPEATABLE READ, takes gap locks on scanned ranges
 *   and deadlocks hot queues (DESIGN.md §1.4).
 * - A fixed strict `sql_mode`, so a bad value is an error and never a silent
 *   truncation, whatever the server's default is. Backslash escapes stay on.
 * - UTC, English server messages, because the affected-row normalization reads the
 *   server's `Rows matched:` line.
 */
const SESSION_SETUP = `SET SESSION
  transaction_isolation = 'READ-COMMITTED',
  sql_mode = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE',
  time_zone = '+00:00',
  lc_messages = 'en_US'`

/**
 * Pool options the store's contract depends on. Without `FOUND_ROWS` an upsert whose
 * conflict arm changes nothing reports zero rows, which is how a compare-and-set that
 * lost is told from one that won.
 */
function ownedPoolOptions(config: string | PoolOptions): PoolOptions {
  const base: PoolOptions = typeof config === 'string' ? { uri: config } : { ...config }
  return {
    connectionLimit: 10,
    ...base,
    flags: [...(base.flags ?? []), '-FOUND_ROWS'],
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    multipleStatements: false,
    // The session settings are sent once for each connection, and a reset clears them.
    resetOnRelease: false,
    charset: 'utf8mb4',
    timezone: 'Z',
  }
}

export function createOwnedMysqlPool(config: string | PoolOptions): Pool {
  return createPool(ownedPoolOptions(config))
}

interface PreparedStatement {
  readonly sql: string
  readonly args: (string | number | bigint | Buffer | null)[]
  readonly skipUnlessWrote?: number
}

/**
 * Count the `?` binds of a statement. A question mark inside a MySQL string literal, a
 * quoted identifier, or a comment is data.
 */
export function countMysqlPlaceholders(sql: string): number {
  let count = 0
  let cursor = 0
  while (cursor < sql.length) {
    const char = sql[cursor] as string
    const next = sql[cursor + 1]
    if (char === "'" || char === '"' || char === '`') {
      cursor += 1
      while (cursor < sql.length) {
        const quoted = sql[cursor]
        if (quoted === '\\' && char !== '`') {
          cursor += 2
          continue
        }
        if (quoted === char) {
          if (sql[cursor + 1] === char) {
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        cursor += 1
      }
      continue
    }
    if (char === '#' || (char === '-' && next === '-')) {
      while (cursor < sql.length && sql[cursor] !== '\n' && sql[cursor] !== '\r') cursor += 1
      continue
    }
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', cursor + 2)
      cursor = close === -1 ? sql.length : close + 2
      continue
    }
    if (char === '?') count += 1
    cursor += 1
  }
  return count
}

function prepareStatements(
  label: string,
  statements: readonly SqlStatement[],
): PreparedStatement[] {
  return statements.map((statement, statementIndex) => {
    const args = statement.args.map((argument, argumentIndex) => {
      if (argument === undefined) {
        throw new TypeError(
          `batch(${label}) statement ${statementIndex} argument ${argumentIndex} is undefined — bind null explicitly if that is what you mean`,
        )
      }
      return argument instanceof Uint8Array
        ? Buffer.from(argument.buffer, argument.byteOffset, argument.byteLength)
        : argument
    })
    const placeholders = countMysqlPlaceholders(statement.sql)
    if (placeholders !== args.length) {
      throw new TypeError(
        `batch(${label}) statement ${statementIndex} has ${placeholders} placeholders but ${args.length} arguments`,
      )
    }
    const gate = statement.skipUnlessWrote
    if (gate === undefined) return { sql: statement.sql, args }
    if (!Number.isInteger(gate) || gate < 0 || gate >= statementIndex) {
      throw new TypeError(
        `batch(${label}) statement ${statementIndex} is gated by statement ${gate}, which is not an earlier statement of the batch`,
      )
    }
    return { sql: statement.sql, args, skipUnlessWrote: gate }
  })
}

function canonicalInteger(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
}

function normalizeInteger(value: unknown, column: string): number | bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return canonicalInteger(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    return canonicalInteger(BigInt(value))
  }
  throw new MysqlResultContractError(`MySQL integer column ${column} returned a non-integral value`)
}

function normalizeValue(value: unknown, field: FieldPacket): SqlRow[string] {
  const type = field.columnType ?? field.type
  if (type !== undefined && TYPE_INTEGERS.has(type)) return normalizeInteger(value, field.name)
  if (value === undefined || value === null) return null
  if (value instanceof Uint8Array) {
    const binary = field.characterSet === BINARY_CHARSET
    if (type !== undefined && TYPE_BLOBS.has(type) && !binary) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
    }
    return new Uint8Array(value)
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value
  }
  throw new MysqlResultContractError(
    `MySQL column ${field.name} returned a value outside the SqlRow contract`,
  )
}

/**
 * MySQL reports a changed-row count, where PostgreSQL and SQLite report a matched one,
 * and counts an upsert that updated as two. Both are normalized to the port's meaning,
 * the rows the statement wrote:
 * - an UPDATE reports the rows it matched, from the server's `Rows matched:` line;
 * - a multi-row or selecting INSERT reports its affected rows less its `Duplicates:`,
 *   because each updated duplicate was counted twice;
 * - a single-row INSERT carries no such line, and can write at most one row. A DELETE
 *   carries no such line either, and its count is already the rows it removed, so the
 *   rule reads the statement and applies to an INSERT alone.
 */
export function writtenRows(
  header: Pick<ResultSetHeader, 'affectedRows' | 'info'>,
  sql: string,
): number {
  const info = header.info ?? ''
  const matched = /^Rows matched: (\d+) {2}Changed: \d+ {2}Warnings: \d+$/.exec(info)
  if (matched !== null) return Number(matched[1])
  const inserted = /^Records: \d+ {2}Duplicates: (\d+) {2}Warnings: \d+$/.exec(info)
  if (inserted !== null) return header.affectedRows - Number(inserted[1])
  const singleRowUpsert = info === '' && header.affectedRows === 2 && /^\s*INSERT\b/i.test(sql)
  return singleRowUpsert ? 1 : header.affectedRows
}

function normalizeResult(
  result: unknown,
  fields: FieldPacket[] | undefined,
  sql: string,
): SqlResult {
  if (Array.isArray(result)) {
    const columns = fields ?? []
    const rows = (result as Record<string, unknown>[]).map((row) => {
      const normalized: SqlRow = {}
      for (const field of columns) normalized[field.name] = normalizeValue(row[field.name], field)
      return normalized
    })
    return { rows, rowsAffected: rows.length }
  }
  return { rows: [], rowsAffected: writtenRows(result as ResultSetHeader, sql) }
}

/** A read batch sees one consistent snapshot, and cannot write. */
const BEGIN_READ = [
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
  'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
] as const
/**
 * The one-statement schema-version read begins under READ COMMITTED, with no snapshot
 * taken ahead of it. A consistent snapshot is older than the statement that reads
 * through it, and MySQL refuses to read a table whose definition committed after the
 * snapshot (error 1412, "Table definition has changed"), so a version read racing a
 * bootstrap failed. Measured over 250 cold starts with six racing readers: 1500 such
 * refusals under the snapshot and none under READ COMMITTED, where the statement sees
 * either no table or the table with its row.
 */
const BEGIN_VERSION_READ = [
  'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  'START TRANSACTION READ ONLY',
] as const

/** Matching coordinates hash to one server-wide lock name, scoped to this database. */
const NAMED_LOCK_SQL = `SELECT GET_LOCK(SHA2(JSON_ARRAY(DATABASE(), ?, ?, ?), 256), ${LOCK_WAIT_SECONDS}) AS acquired`
const NAMED_UNLOCK_SQL = `SELECT RELEASE_LOCK(SHA2(JSON_ARRAY(DATABASE(), ?, ?, ?), 256)) AS released`

type LockCoordinates = readonly [domain: string, first: string, second: string]

function lockCoordinates(lock: SqlTransactionLock): LockCoordinates {
  return lock.kind === 'event'
    ? ['durablerun:event', lock.queue, lock.eventName]
    : ['durablerun:claim', lock.queue, lock.claimToken]
}

/**
 * A named lock is held by the session, not the transaction, so it is taken before the
 * transaction starts and released after it ends. Rows therefore never wait on a lock
 * while holding row locks of their own, and a connection that dies releases it.
 */
async function acquireNamedLock(connection: PoolConnection, lock: LockCoordinates): Promise<void> {
  const [rows] = await connection.execute(NAMED_LOCK_SQL, [...lock])
  const acquired = (rows as { acquired: unknown }[])[0]?.acquired
  if (Number(acquired) !== 1) {
    throw new StoreUnavailableError(
      `could not take the ${lock[0]} lock within ${LOCK_WAIT_SECONDS} seconds (GET_LOCK returned ${String(acquired)})`,
    )
  }
}

/**
 * MySQL cuts trailing spaces past a VARCHAR's width with a note, in every `sql_mode`, where
 * any other excess is error 1406. The cut value is a different identifier, so a write that
 * was cut is refused like one that did not fit, and its transaction rolls back. The server
 * reports a warning count with every result, so this costs a round trip only when there
 * is something to read.
 */
async function refuseWriteCutToFit(
  connection: PoolConnection,
  header: Pick<ResultSetHeader, 'warningStatus'>,
): Promise<void> {
  if ((header.warningStatus ?? 0) === 0) return
  const [warnings] = await connection.query('SHOW WARNINGS')
  const cut = (warnings as { Code?: unknown; Message?: unknown }[]).find(
    (warning) => Number(warning.Code) === WARN_DATA_TRUNCATED,
  )
  if (cut !== undefined) {
    throw new InvalidDurableStringError(
      `MySQL cut a value to fit its column, and an indexed identifier holds 255 characters: ${String(cut.Message)}`,
    )
  }
}

function isSchemaVersionRead(
  label: string,
  statements: readonly SqlStatement[],
  mode: SqlBatchMode,
): boolean {
  const statement = statements[0]
  return (
    label === 'migrate:version' &&
    mode === 'read' &&
    statements.length === 1 &&
    statement?.sql === SCHEMA_VERSION_READ_SQL &&
    statement.args.length === 0
  )
}

const isMigrationWrite = (label: string, mode: SqlBatchMode): boolean =>
  mode === 'write' && (label === 'migrate:bootstrap' || /^migrate:v[0-9]+$/.test(label))

function errorNumber(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno
  return typeof errno === 'number' ? errno : undefined
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function classifyError(error: unknown, label: string, schemaVersionRead: boolean): Error {
  if (
    error instanceof MysqlResultContractError ||
    error instanceof InvalidDurableStringError ||
    error instanceof SchemaMismatchError ||
    error instanceof SchemaNotInitializedError ||
    error instanceof StoreUnavailableError
  ) {
    return error
  }
  const errno = errorNumber(error)
  if (errno !== undefined) {
    if (schemaVersionRead && errno === ER_NO_SUCH_TABLE) {
      return new SchemaNotInitializedError('schema metadata has not been initialized', {
        cause: error,
      })
    }
    if (errno === ER_DATA_TOO_LONG) {
      return new InvalidDurableStringError(
        `batch(${label}) bound a string longer than its MySQL column holds, and an indexed identifier holds 255 characters: ${errorDescription(error)}`,
        { cause: error },
      )
    }
    if (SCHEMA_MISMATCH_ERRNOS.has(errno)) {
      return new SchemaMismatchError(
        `batch(${label}) hit a schema this build does not expect (MySQL error ${errno}): ${errorDescription(error)}`,
        { cause: error },
      )
    }
  }
  const state = errno === undefined ? '' : ` (MySQL error ${errno})`
  return new StoreUnavailableError(`batch(${label}) failed${state}: ${errorDescription(error)}`, {
    cause: error,
  })
}

/**
 * SqlExecutor over mysql2. Every batch owns one connection and one transaction, so
 * statements are ordered and observe earlier statements of the same batch. Write batches
 * run at READ COMMITTED. Read batches run in a read-only consistent snapshot.
 *
 * Statements that carry arguments go through the server's prepared-statement protocol,
 * so a bind is data and never SQL text.
 *
 * A DDL statement commits on its own in MySQL. Only migration batches hold DDL, and they
 * run one at a time under the migration lock, with every statement safe to repeat. The
 * schema-version read takes no lock: the bootstrap is one statement, so there is no
 * state between "no version table" and "a version table with its row" to be kept from.
 */
export class MysqlExecutor implements SqlExecutor {
  private closePromise: Promise<void> | null = null
  private readonly configured = new WeakSet<object>()

  private constructor(
    private readonly pool: PoolPort,
    private readonly ownsPool: boolean,
  ) {}

  static open(config: string | PoolOptions): MysqlExecutor {
    return new MysqlExecutor(createOwnedMysqlPool(config), true)
  }

  /**
   * A pool the caller owns. It must connect without `FOUND_ROWS`, as
   * `createOwnedMysqlPool` builds one: mysql2 turns the flag on by default, and under it
   * a conflict arm that changed nothing reports one row, so a compare-and-set that lost
   * would read as one that won. The flag is part of the handshake and no session
   * setting can repair it, so a pool that has it, or whose flags cannot be read, is
   * refused here. So is a pool that resets a connection on release, or that does not
   * say: the session settings are sent once for each connection, and mysql2's
   * `resetOnRelease` clears them on every release, which left every write after the
   * first at REPEATABLE READ with the server's time zone and no strict mode. For the
   * same reason nothing else that uses the pool may change a connection's session state.
   */
  static fromPool(pool: Pool): MysqlExecutor {
    const config = (
      pool as {
        pool?: {
          config?: { resetOnRelease?: unknown; connectionConfig?: { clientFlags?: unknown } }
        }
      }
    ).pool?.config
    const flags = config?.connectionConfig?.clientFlags
    if (typeof flags !== 'number' || (flags & CLIENT_FOUND_ROWS) !== 0) {
      throw new TypeError(
        "MysqlExecutor.fromPool needs a pool that connects without FOUND_ROWS: build it with createOwnedMysqlPool, or pass flags: ['-FOUND_ROWS']",
      )
    }
    if (config?.resetOnRelease !== false) {
      throw new TypeError(
        'MysqlExecutor.fromPool needs a pool that never resets a connection on release: build it with createOwnedMysqlPool, or pass resetOnRelease: false',
      )
    }
    return new MysqlExecutor(pool, false)
  }

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    control: SqlBatchControl = 'write',
  ): Promise<SqlResult[]> {
    const prepared = prepareStatements(label, statements)
    if (prepared.length === 0) return []
    const mode = sqlBatchMode(control)
    const transactionLock = sqlTransactionLock(control)
    const schemaVersionRead = isSchemaVersionRead(label, statements, mode)
    const lock: LockCoordinates | null =
      transactionLock !== undefined
        ? lockCoordinates(transactionLock)
        : isMigrationWrite(label, mode)
          ? [MIGRATION_LOCK, '', '']
          : null

    let connection: PoolConnection
    try {
      connection = await this.pool.getConnection()
    } catch (error) {
      throw classifyError(error, label, false)
    }

    let discard = false
    try {
      // The pool hands out a new wrapper on every checkout, so the settings are
      // remembered against the physical connection under it.
      const physical: object = (connection as { connection?: object }).connection ?? connection
      if (!this.configured.has(physical)) {
        await connection.query(SESSION_SETUP)
        this.configured.add(physical)
      }
      return await this.transact(connection, prepared, mode, lock, schemaVersionRead)
    } catch (error) {
      discard = !(error instanceof MysqlResultContractError) && errorNumber(error) === undefined
      throw classifyError(error, label, schemaVersionRead)
    } finally {
      if (discard) connection.destroy()
      else connection.release()
    }
  }

  private async transact(
    connection: PoolConnection,
    prepared: readonly PreparedStatement[],
    mode: SqlBatchMode,
    lock: LockCoordinates | null,
    schemaVersionRead: boolean,
  ): Promise<SqlResult[]> {
    let locked = false
    let transactionStarted = false
    try {
      if (lock !== null) {
        await acquireNamedLock(connection, lock)
        locked = true
      }
      if (mode === 'read') {
        for (const statement of schemaVersionRead ? BEGIN_VERSION_READ : BEGIN_READ) {
          await connection.query(statement)
        }
      } else {
        await connection.query('START TRANSACTION')
      }
      transactionStarted = true
      const results: SqlResult[] = []
      for (const statement of prepared) {
        // Each statement is a round trip here. One whose gating statement wrote no row
        // cannot match a row (`SqlStatement.skipUnlessWrote`), so it is not sent. The
        // gate's count is the port's, rows matched: MySQL's own count is rows changed,
        // and a gate that matched a row and changed nothing would read as zero there.
        const gate = statement.skipUnlessWrote
        if (gate !== undefined && results[gate]?.rowsAffected === 0) {
          results.push({ rows: [], rowsAffected: 0 })
          continue
        }
        const [result, fields] =
          statement.args.length === 0
            ? await connection.query(statement.sql)
            : await connection.execute(statement.sql, statement.args)
        if (mode === 'write' && !Array.isArray(result)) {
          await refuseWriteCutToFit(connection, result as ResultSetHeader)
        }
        results.push(normalizeResult(result, fields as FieldPacket[] | undefined, statement.sql))
      }
      await connection.query('COMMIT')
      transactionStarted = false
      return results
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.query('ROLLBACK')
        } catch {
          // The connection is discarded below: a failed rollback leaves it unusable.
          throw new StoreUnavailableError(
            `MySQL rollback failed after: ${errorDescription(error)}`,
            { cause: error },
          )
        }
      }
      throw error
    } finally {
      if (locked && lock !== null) {
        await connection.execute(NAMED_UNLOCK_SQL, [...lock]).catch(() => connection.destroy())
      }
    }
  }

  close(): Promise<void> {
    if (!this.ownsPool) return Promise.resolve()
    this.closePromise ??= this.pool.end()
    return this.closePromise
  }
}

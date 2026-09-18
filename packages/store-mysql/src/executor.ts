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

/** MySQL errors that prove the installed relations differ from this build. */
const SCHEMA_MISMATCH_ERRNOS = new Set([
  1049, // ER_BAD_DB_ERROR
  1050, // ER_TABLE_EXISTS_ERROR
  1054, // ER_BAD_FIELD_ERROR
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
  1146, // ER_NO_SUCH_TABLE
  1305, // ER_SP_DOES_NOT_EXIST
])
const ER_NO_SUCH_TABLE = 1146
/**
 * A string is longer than its column. Only an indexed identifier is bounded here, at 255
 * characters, because MySQL cannot index unbounded text. It is invalid input and
 * permanent: reported as an outage it would be retried until a run's infrastructure
 * budget was gone.
 */
const ER_DATA_TOO_LONG = 1406

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
    return { sql: statement.sql, args }
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
 * - a single-row INSERT carries no such line, and can write at most one row.
 */
export function writtenRows(header: Pick<ResultSetHeader, 'affectedRows' | 'info'>): number {
  const info = header.info ?? ''
  const matched = /^Rows matched: (\d+) {2}Changed: \d+ {2}Warnings: \d+$/.exec(info)
  if (matched !== null) return Number(matched[1])
  const inserted = /^Records: \d+ {2}Duplicates: (\d+) {2}Warnings: \d+$/.exec(info)
  if (inserted !== null) return header.affectedRows - Number(inserted[1])
  return info === '' && header.affectedRows === 2 ? 1 : header.affectedRows
}

function normalizeResult(result: unknown, fields: FieldPacket[] | undefined): SqlResult {
  if (Array.isArray(result)) {
    const columns = fields ?? []
    const rows = (result as Record<string, unknown>[]).map((row) => {
      const normalized: SqlRow = {}
      for (const field of columns) normalized[field.name] = normalizeValue(row[field.name], field)
      return normalized
    })
    return { rows, rowsAffected: rows.length }
  }
  return { rows: [], rowsAffected: writtenRows(result as ResultSetHeader) }
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

  /** The pool must have been built by `createOwnedMysqlPool`: the affected-row contract depends on its flags. */
  static fromPool(pool: Pool): MysqlExecutor {
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
      if (!this.configured.has(connection)) {
        await connection.query(SESSION_SETUP)
        this.configured.add(connection)
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
        const [result, fields] =
          statement.args.length === 0
            ? await connection.query(statement.sql)
            : await connection.execute(statement.sql, statement.args)
        results.push(normalizeResult(result, fields as FieldPacket[] | undefined))
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

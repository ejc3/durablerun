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
  isTreeBuiltRead,
  refuseUnknownLockKind,
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

/** InnoDB found a deadlock and rolled this transaction back so that another could proceed. */
const ER_LOCK_DEADLOCK = 1213
/** How many times a write batch runs before a deadlock is reported as an outage. */
const DEADLOCK_VICTIM_ATTEMPTS = 3

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
 * - Autocommit on. It is the server's default, and a read sent alone depends on it
 *   (`sentAlone`): with autocommit off, the read would open a transaction that stays open
 *   on a pooled connection.
 */
const SESSION_SETUP = `SET SESSION
  autocommit = 1,
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

/** A read batch sees one consistent snapshot and cannot write, unless it is one read sent alone (`sentAlone`). */
const BEGIN_READ = [
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
  'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
] as const

/** Matching coordinates hash to one server-wide lock name, scoped to this database. */
const NAMED_LOCK_SQL = `SELECT GET_LOCK(SHA2(JSON_ARRAY(DATABASE(), ?, ?, ?), 256), ${LOCK_WAIT_SECONDS}) AS acquired`
const NAMED_UNLOCK_SQL = `SELECT RELEASE_LOCK(SHA2(JSON_ARRAY(DATABASE(), ?, ?, ?), 256)) AS released`

type LockCoordinates = readonly [domain: string, first: string, second: string]

function lockCoordinates(lock: SqlTransactionLock): LockCoordinates {
  switch (lock.kind) {
    case 'event':
      return ['durablerun:event', lock.queue, lock.eventName]
    case 'claim':
      return ['durablerun:claim', lock.queue, lock.claimToken]
    case 'migration':
      return [MIGRATION_LOCK, '', '']
    default:
      return refuseUnknownLockKind(lock)
  }
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
 * MySQL cuts trailing spaces past a VARCHAR's width with a note, in every `sql_mode`, and was
 * measured to cut a trailing tab and a trailing line break the same way under this session's
 * mode, where any other excess is error 1406. The cut value is a different identifier, so a
 * write that was cut is refused like one that did not fit, and its transaction rolls back. The
 * server reports a warning count with every result, so this costs a round trip only when there
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

/**
 * Whether a batch is sent as its one statement alone, with no transaction around it. The
 * session has autocommit on, so the server commits the statement by itself, in one round
 * trip where a read batch's transaction cost four.
 *
 * Only a read goes alone, and only one the executor KNOWS is a read: a statement core
 * compiled on its read path (`isTreeBuiltRead`), whose root is a SELECT inside a closed
 * grammar, or the canonical schema-version read, which is matched by its whole text. How a
 * statement's text begins shows nothing, because a text that begins with SELECT can still
 * call what writes. A read sent as text therefore keeps the read-only transaction, where
 * the server refuses every write.
 *
 * The brand says where a statement came from, and not what a store's own fragment holds:
 * core reads a fragment for clocks and comments only. A fragment that holds a second
 * statement is refused by the server, which takes one statement in a text unless the
 * connection asked for more, and a pool this executor opens never does
 * (`multipleStatements: false`). A pool handed to `fromPool` that does is outside what was
 * checked. A fragment that CALLS a function that writes is refused by nothing once the
 * read goes alone. No read of the stores calls one.
 *
 * What the transaction gave such a read still holds. One statement reads through one view
 * under READ COMMITTED, its subqueries included. The schema-version read has to be such a
 * statement: a snapshot taken ahead of it is older than a table created since, and MySQL
 * refuses to read such a table (error 1412). Measured over 250 cold starts with six racing
 * readers: 1500 such refusals under a snapshot, and none for one statement under READ
 * COMMITTED, which sees either no table or the table with its row.
 *
 * A write always keeps its transaction. The transaction is what rolls a write back when
 * MySQL cut a value to fit (`refuseWriteCutToFit`) or when its result is refused, and the
 * executor learns of either only after the server has run the statement. Nothing about a
 * statement's text or binds shows that neither will happen: MySQL cuts a trailing tab or
 * line break as it cuts a space, in a bind sent as bytes or a literal in the text as in a
 * bound string.
 */
function sentAlone(
  statements: readonly SqlStatement[],
  mode: SqlBatchMode,
  schemaVersionRead: boolean,
): boolean {
  const [statement] = statements
  if (statement === undefined || statements.length !== 1) return false
  if (mode !== 'read') return false
  return schemaVersionRead || isTreeBuiltRead(statement)
}

/**
 * The canonical version read, for which a missing table means a database with no schema
 * yet. It is matched by its whole text, so the executor knows it for a read and sends it
 * alone.
 */
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

/**
 * A write whose label begins with `migrate:` is a migration write, and it has to name the
 * migration lock in its control. The label is read here only to REFUSE. The lock a batch
 * runs under is the one its control names, and no label chooses one: chosen from a list of
 * labels, a `migrate:` label the list does not know runs its DDL beside another migrator,
 * and MySQL commits each DDL statement on its own, so nothing can undo it.
 */
function refuseMigrationWriteWithoutItsLock(
  label: string,
  mode: SqlBatchMode,
  lock: SqlTransactionLock | undefined,
): void {
  if (mode === 'write' && label.startsWith('migrate:') && lock?.kind !== 'migration') {
    throw new TypeError(
      `batch(${label}) is a migration write that names no migration lock: pass core's MIGRATION_WRITE as its batch control`,
    )
  }
}

function errorNumber(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno
  return typeof errno === 'number' ? errno : undefined
}

/** One definition of a deadlock victim, for the count and for the decision to run it again. */
function isDeadlockVictim(error: unknown): boolean {
  return errorNumber(error) === ER_LOCK_DEADLOCK
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
 * SqlExecutor over mysql2. Every batch owns one connection. A batch of more than one
 * statement owns one transaction, so its statements are ordered, atomic, and observe
 * earlier statements of the same batch: a write batch at READ COMMITTED, a read batch
 * in a read-only consistent snapshot. One read that the executor knows to be a read is
 * sent alone, because one statement reads one view by itself (`sentAlone`).
 *
 * Statements that carry arguments go through the server's prepared-statement protocol,
 * so a bind is data and never SQL text.
 *
 * A DDL statement commits on its own in MySQL. Only migration batches hold DDL, and they
 * run one at a time under the migration lock, which each names in its control
 * (`refuseMigrationWriteWithoutItsLock`), with every statement safe to repeat. The
 * schema-version read takes no lock: the bootstrap is one statement, so there is no
 * state between "no version table" and "a version table with its row" to be kept from.
 */
export class MysqlExecutor implements SqlExecutor {
  private closePromise: Promise<void> | null = null
  private readonly configured = new WeakSet<object>()
  private deadlockVictims = 0

  private constructor(
    private readonly pool: PoolPort,
    private readonly ownsPool: boolean,
  ) {}

  /**
   * How many times InnoDB has chosen a batch of this executor as a deadlock victim,
   * counting a batch that was then run again and one that was reported. Running the victim
   * again hides a lock-order inversion from every caller, so a test holds this at zero
   * wherever correct code never deadlocks. The server's own count is shared by every
   * session of the server and cannot say whose transaction it was.
   */
  get deadlocks(): number {
    return this.deadlockVictims
  }

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
    const mode = sqlBatchMode(control)
    const transactionLock = sqlTransactionLock(control)
    // Both refusals come before anything is sent, and before an empty batch is answered.
    refuseMigrationWriteWithoutItsLock(label, mode, transactionLock)
    const lock = transactionLock === undefined ? null : lockCoordinates(transactionLock)
    if (prepared.length === 0) return []
    const schemaVersionRead = isSchemaVersionRead(label, statements, mode)
    // Decided here, beside the copy and before any wait: what the caller's array holds
    // after a wait is not what was copied. The brand is on the caller's own object.
    const alone = sentAlone(statements, mode, schemaVersionRead)

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
      return await this.transact(connection, prepared, mode, lock, alone)
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
    alone: boolean,
  ): Promise<SqlResult[]> {
    let locked = false
    try {
      if (lock !== null) {
        await acquireNamedLock(connection, lock)
        locked = true
      }
      for (let attempt = 1; ; attempt += 1) {
        let transactionStarted = false
        try {
          if (!alone) {
            if (mode === 'read') {
              for (const statement of BEGIN_READ) await connection.query(statement)
            } else {
              await connection.query('START TRANSACTION')
            }
            transactionStarted = true
          }
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
            results.push(
              normalizeResult(result, fields as FieldPacket[] | undefined, statement.sql),
            )
          }
          if (transactionStarted) await connection.query('COMMIT')
          transactionStarted = false
          return results
        } catch (error) {
          // Counted before the rollback: a victim whose rollback then fails is reported
          // from inside that block, and it is a victim all the same.
          if (isDeadlockVictim(error)) this.deadlockVictims += 1
          if (transactionStarted) {
            try {
              await connection.query('ROLLBACK')
            } catch {
              // The connection is discarded by the caller: a failed rollback leaves it unusable.
              throw new StoreUnavailableError(
                `MySQL rollback failed after: ${errorDescription(error)}`,
                { cause: error },
              )
            }
          }
          // InnoDB ends a deadlock by rolling one transaction back. That batch committed
          // nothing, so running it again is a first delivery, and the other transaction
          // has its locks by now. Reported as an outage, a finished run would be left for
          // the sweep to charge an infrastructure retry. Only a write batch is run again.
          // A read batch cannot be a victim here today: a consistent read takes no InnoDB
          // lock, and MySQL commits each DDL statement on its own, so no version holds a lock
          // on one table while it waits for another, which is what aborted reads on
          // PostgreSQL (DESIGN.md §3.4 rule 11). A version that does is the trigger to run a
          // read again here as well. The named lock is held across the attempts, because it
          // was taken before the transaction and a rollback does not release it.
          const runAgain =
            mode === 'write' && attempt < DEADLOCK_VICTIM_ATTEMPTS && isDeadlockVictim(error)
          if (!runAgain) throw error
        }
      }
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

import {
  RESERVED_EVENT_PREFIX,
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
  DatabaseError,
  type FieldDef,
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
} from 'pg'
import { compilePostgresPlaceholders } from './placeholders.js'
import { SCHEMA_VERSION_READ_SQL } from './schema.js'

const INT8_OID = 20
const BYTEA_OID = 17

/** PostgreSQL states that prove the installed relations differ from this build. */
const SCHEMA_MISMATCH_SQLSTATES = new Set([
  '3F000', // invalid_schema_name
  '42701', // duplicate_column
  '42703', // undefined_column
  '42704', // undefined_object
  '42804', // datatype_mismatch
  '42883', // undefined_function/operator for the installed column types
  '42P01', // undefined_table
  '42P07', // duplicate_table/relation
])

type PoolPort = Pick<Pool, 'connect' | 'end'>

interface PreparedStatement {
  readonly sql: string
  readonly args: unknown[]
  readonly skipUnlessWrote?: number
}

class PostgresResultContractError extends TypeError {}

/**
 * Construct a pool whose idle-client failures have an EventEmitter owner.
 * pg-pool removes the failed idle client before emitting; the listener keeps
 * that recoverable pool maintenance event from terminating the Node process.
 */
export function createOwnedPostgresPool(config: string | PoolConfig = {}): Pool {
  const pool = new Pool(typeof config === 'string' ? { connectionString: config } : config)
  pool.on('error', (error) => {
    void error
  })
  return pool
}

function prepareStatements(
  label: string,
  statements: readonly SqlStatement[],
): PreparedStatement[] {
  return statements.map((statement, statementIndex) => {
    for (const [argumentIndex, argument] of statement.args.entries()) {
      if (argument === undefined) {
        throw new TypeError(
          `batch(${label}) statement ${statementIndex} argument ${argumentIndex} is undefined — bind null explicitly if that is what you mean`,
        )
      }
    }

    const compiled = compilePostgresPlaceholders(statement.sql)
    if (compiled.parameterCount !== statement.args.length) {
      throw new TypeError(
        `batch(${label}) statement ${statementIndex} has ${compiled.parameterCount} placeholders but ${statement.args.length} arguments`,
      )
    }
    const gate = statement.skipUnlessWrote
    if (gate === undefined) return { sql: compiled.sql, args: [...statement.args] }
    if (!Number.isInteger(gate) || gate < 0 || gate >= statementIndex) {
      throw new TypeError(
        `batch(${label}) statement ${statementIndex} is gated by statement ${gate}, which is not an earlier statement of the batch`,
      )
    }
    return { sql: compiled.sql, args: [...statement.args], skipUnlessWrote: gate }
  })
}

function canonicalInt8(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
}

function normalizeInt8(value: unknown, column: string): number | bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return canonicalInt8(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    return canonicalInt8(BigInt(value))
  }
  throw new PostgresResultContractError(
    `PostgreSQL int8 column ${column} returned a non-integral value`,
  )
}

function normalizeBytea(value: unknown, column: string): Uint8Array | null {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  throw new PostgresResultContractError(
    `PostgreSQL bytea column ${column} returned a non-binary value`,
  )
}

function normalizeValue(value: unknown, field: FieldDef): SqlRow[string] {
  if (field.dataTypeID === INT8_OID) return normalizeInt8(value, field.name)
  if (field.dataTypeID === BYTEA_OID) return normalizeBytea(value, field.name)
  if (value === undefined || value === null) return null
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value instanceof Uint8Array ? new Uint8Array(value) : value
  }
  throw new PostgresResultContractError(
    `PostgreSQL column ${field.name} returned a value outside the SqlRow contract`,
  )
}

function normalizeResult(result: QueryResult<Record<string, unknown>>): SqlResult {
  const rows = result.rows.map((row) => {
    const normalized: SqlRow = {}
    for (const field of result.fields)
      normalized[field.name] = normalizeValue(row[field.name], field)
    return normalized
  })
  return {
    rows,
    rowsAffected: result.fields.length > 0 ? rows.length : (result.rowCount ?? 0),
  }
}

async function acquireTransactionLock(client: PoolClient, lock: SqlTransactionLock): Promise<void> {
  if (lock.kind === 'event' && !lock.eventName.startsWith(RESERVED_EVENT_PREFIX)) {
    // A caller's event takes the lock every build has taken for it: a row of
    // `event_locks`, inserted when it is missing and then locked. A process of an older
    // build keeps running after a newer one has migrated, because a store never reads
    // the schema version, so for the length of a deploy both builds emit and await the
    // same events. Two lock kinds would not exclude each other, and an emit could then
    // slip between an await's read of no event and its wait row, which strands the
    // waiter. The row can go once no build that takes it can still run (BUILD.md).
    const args = [lock.queue, lock.eventName]
    await client.query(
      `INSERT INTO event_locks (queue, event_name)
       VALUES ($1, $2)
       ON CONFLICT (queue, event_name) DO NOTHING`,
      args,
    )
    await client.query(
      `SELECT 1 FROM event_locks
       WHERE queue = $1 AND event_name = $2
       FOR UPDATE`,
      args,
    )
    return
  }
  if (lock.kind === 'event') {
    // The engine's own event, which is the completion event of a task. No build before
    // child tasks locks one, so nothing has to agree with a row, and a row would be a
    // row for every task that ever ends, awaited or not, which nothing deletes. The
    // lock is transaction-scoped and advisory. Its key is the identity of the `events`
    // table as this session resolves it, so two pools that reach the same tables
    // through different search paths still exclude each other. A hash collision can
    // only over-serialize unrelated events.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         jsonb_build_array(
           'durablerun:event', 'events'::regclass::oid::text, $1::text, $2::text
         )::text,
         0
       ))`,
      [lock.queue, lock.eventName],
    )
    return
  }

  // Claim tokens are fresh per tick, so a durable row sentinel would grow
  // without bound. A transaction-scoped advisory lock has exactly the needed
  // lifetime. PostgreSQL computes the key from bound coordinates plus the
  // database/schema and a fixed domain tag; a hash collision can only
  // over-serialize unrelated claims, never let equal coordinates overlap.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       jsonb_build_array(
         current_database(), current_schema(), 'durablerun:claim', $1::text, $2::text
       )::text,
       0
     ))`,
    [lock.queue, lock.claimToken],
  )
}

// A read batch is one REPEATABLE READ snapshot. The canonical schema-version read is the
// exception. PostgreSQL resolves a name against the newest catalog, and REPEATABLE READ
// takes its snapshot before the statement does that, so the read could see a concurrent
// bootstrap's meta table and not the version row committed with it. READ COMMITTED takes
// the execution snapshot after the lookup, and one statement needs no snapshot held
// across statements. Raced through real migrators: rejected in 18 of 300 rounds under
// REPEATABLE READ, and in none of 1800 under READ COMMITTED.
const BEGIN_READ = 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
const BEGIN_VERSION_READ = 'BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY'

const BEGINS_WITH_SELECT = /^\s*SELECT\b/i
const NAMES_INTO = /\bINTO\b/i

/**
 * Whether a batch is sent as its one statement alone, outside a transaction block, where
 * PostgreSQL runs it in a transaction of its own. It is as atomic as the batch was, in
 * one round trip where the transaction cost three. What the transaction gave a batch of
 * one statement still holds:
 * - A read batch's snapshot. One statement reads through one snapshot, its subqueries
 *   included, at any isolation level.
 * - A read batch's READ ONLY, under which the server refuses a write. A statement that
 *   begins with SELECT writes nothing unless it names INTO, which creates a table: one
 *   that changes rows from inside a query must begin with WITH, and this schema installs
 *   no function for a query to call. Any other statement sent as a read keeps the
 *   read-only transaction.
 * - The schema-version read's READ COMMITTED. Alone it would run at the session's default
 *   level, which belongs to whoever owns the pool, so it keeps its transaction.
 * A lock coordinate keeps the transaction too, because both kinds of lock end with it.
 */
function sentAlone(
  prepared: readonly PreparedStatement[],
  mode: SqlBatchMode,
  transactionLock: SqlTransactionLock | undefined,
  schemaVersionRead: boolean,
): boolean {
  const [statement] = prepared
  if (statement === undefined || prepared.length !== 1) return false
  if (transactionLock !== undefined) return false
  if (schemaVersionRead) return false
  if (mode !== 'read') return true
  if (NAMES_INTO.test(statement.sql)) return false
  return BEGINS_WITH_SELECT.test(statement.sql)
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

function errorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** SQLSTATE deadlock_detected: this transaction was aborted so that another could proceed. */
const DEADLOCK_DETECTED = '40P01'
/** How many times a batch runs before a deadlock is reported as an outage. */
const DEADLOCK_VICTIM_ATTEMPTS = 3

/** One definition of a deadlock victim, for the count and for the decision to run it again. */
function isDeadlockVictim(error: unknown): boolean {
  return error instanceof DatabaseError && error.code === DEADLOCK_DETECTED
}

function classifyError(error: unknown, label: string, schemaVersionRead: boolean): Error {
  if (
    error instanceof PostgresResultContractError ||
    error instanceof SchemaMismatchError ||
    error instanceof SchemaNotInitializedError ||
    error instanceof StoreUnavailableError
  ) {
    return error
  }

  if (error instanceof DatabaseError) {
    if (schemaVersionRead && error.code === '42P01') {
      return new SchemaNotInitializedError('schema metadata has not been initialized', {
        cause: error,
      })
    }
    if (error.code !== undefined && SCHEMA_MISMATCH_SQLSTATES.has(error.code)) {
      return new SchemaMismatchError(
        `batch(${label}) hit a schema this build does not expect (SQLSTATE ${error.code}): ${error.message}`,
        { cause: error },
      )
    }
  }

  const state =
    error instanceof DatabaseError && error.code !== undefined ? ` (SQLSTATE ${error.code})` : ''
  return new StoreUnavailableError(`batch(${label}) failed${state}: ${errorDescription(error)}`, {
    cause: error,
  })
}

/**
 * SqlExecutor over node-postgres. Every batch owns one checked-out client. A batch of
 * more than one statement owns one transaction, so its statements are atomic, ordered,
 * and observe earlier statements from the same batch: a read batch in a repeatable-read,
 * read-only snapshot, a write batch at PostgreSQL's read-committed default. A batch of
 * one statement is sent alone, because one statement is atomic and reads one snapshot by
 * itself (`sentAlone`).
 */
export class PgExecutor implements SqlExecutor {
  private closePromise: Promise<void> | null = null
  private deadlockVictims = 0

  private constructor(
    private readonly pool: PoolPort,
    private readonly ownsPool: boolean,
  ) {}

  /**
   * How many times PostgreSQL has chosen a batch of this executor as a deadlock victim,
   * counting a batch that was then run again and one that was reported. Running the victim
   * again hides a lock-order inversion from every caller, so a test holds this at zero.
   * The server's own count, `pg_stat_database.deadlocks`, is shared by everything connected
   * to the database and cannot say whose transaction it was.
   */
  get deadlocks(): number {
    return this.deadlockVictims
  }

  static open(config: string | PoolConfig = {}): PgExecutor {
    return new PgExecutor(createOwnedPostgresPool(config), true)
  }

  static fromPool(pool: Pool): PgExecutor {
    return new PgExecutor(pool, false)
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
    const alone = sentAlone(prepared, mode, transactionLock, schemaVersionRead)

    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch (error) {
      throw classifyError(error, label, false)
    }

    // pg-pool removes its idle listener while a client is checked out. Own
    // errors for exactly that interval so a backend/socket loss rejects the
    // active query instead of also becoming an unhandled process-fatal event.
    // The recorded error discards the client even if rollback happens to work.
    let clientError: Error | undefined
    const onClientError = (error: Error): void => {
      clientError ??= error
    }
    client.on('error', onClientError)

    let releaseError: Error | undefined
    try {
      for (let attempt = 1; ; attempt += 1) {
        let transactionStarted = false
        let activeStatementIndex: number | null = null
        try {
          if (!alone) {
            await client.query(
              mode !== 'read' ? 'BEGIN' : schemaVersionRead ? BEGIN_VERSION_READ : BEGIN_READ,
            )
            transactionStarted = true
          }

          if (transactionLock !== undefined) {
            await acquireTransactionLock(client, transactionLock)
          }

          const results: SqlResult[] = []
          for (const [statementIndex, statement] of prepared.entries()) {
            // Each statement is a round trip here. One whose gating statement wrote no
            // row cannot match a row (`SqlStatement.skipUnlessWrote`), so it is not sent.
            const gate = statement.skipUnlessWrote
            if (gate !== undefined && results[gate]?.rowsAffected === 0) {
              results.push({ rows: [], rowsAffected: 0 })
              continue
            }
            activeStatementIndex = statementIndex
            const result = await client.query<Record<string, unknown>>(
              statement.sql,
              statement.args,
            )
            activeStatementIndex = null
            results.push(normalizeResult(result))
          }
          if (transactionStarted) await client.query('COMMIT')
          transactionStarted = false
          return results
        } catch (error) {
          const failedSchemaVersionRead = schemaVersionRead && activeStatementIndex === 0
          if (transactionStarted) {
            try {
              await client.query('ROLLBACK')
            } catch (rollbackError) {
              releaseError =
                rollbackError instanceof Error
                  ? rollbackError
                  : new Error('PostgreSQL rollback failed', { cause: rollbackError })
            }
          }
          // PostgreSQL ends a deadlock by aborting one transaction, which for a statement
          // sent alone is the statement. That batch committed nothing, so running it again
          // is a first delivery, and the other transaction has its locks by now. Reported
          // as an outage, a finished run would be left for the sweep to charge an
          // infrastructure retry. Only a write batch is run again: a read batch takes no
          // row lock, so a deadlock there is not this engine's lock order. It is run again
          // at once, because PostgreSQL chose the victim only after `deadlock_timeout`, and
          // a store source has no timer to wait on.
          if (isDeadlockVictim(error)) this.deadlockVictims += 1
          const runAgain =
            mode !== 'read' &&
            attempt < DEADLOCK_VICTIM_ATTEMPTS &&
            releaseError === undefined &&
            clientError === undefined &&
            isDeadlockVictim(error)
          if (!runAgain) throw classifyError(error, label, failedSchemaVersionRead)
        }
      }
    } finally {
      try {
        client.release(releaseError ?? clientError)
      } finally {
        // release() synchronously restores pg-pool's idle listener first.
        client.removeListener('error', onClientError)
      }
    }
  }

  close(): Promise<void> {
    if (!this.ownsPool) return Promise.resolve()
    this.closePromise ??= this.pool.end()
    return this.closePromise
  }
}

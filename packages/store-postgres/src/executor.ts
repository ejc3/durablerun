import {
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

/** The advisory-lock domain of each lock kind, so an event and a claim never share a key. */
const LOCK_DOMAINS = Object.freeze({
  event: 'durablerun:event',
  claim: 'durablerun:claim',
} as const)

async function acquireTransactionLock(client: PoolClient, lock: SqlTransactionLock): Promise<void> {
  // Both locks are transaction-scoped advisory locks, which have exactly the needed
  // lifetime and leave nothing behind. A durable row sentinel would grow without
  // bound: claim tokens are fresh per tick, and every task that ends locks the name
  // of its own completion event, whether or not anyone ever awaits it. PostgreSQL
  // computes the key from bound coordinates plus the database/schema and a fixed
  // domain tag; a hash collision can only over-serialize unrelated transitions, never
  // let equal coordinates overlap. Equal coordinates of one kind exclude each other,
  // which is all an emit, an await, and a terminal batch of one event need.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       jsonb_build_array(
         current_database(), current_schema(), '${LOCK_DOMAINS[lock.kind]}', $1::text, $2::text
       )::text,
       0
     ))`,
    [lock.queue, lock.kind === 'event' ? lock.eventName : lock.claimToken],
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
 * SqlExecutor over node-postgres. Every batch owns one checked-out client and
 * one transaction, so statements are atomic, ordered, and observe earlier
 * statements from the same batch. Read batches use a repeatable-read,
 * read-only snapshot; write batches use PostgreSQL's read-committed default.
 */
export class PgExecutor implements SqlExecutor {
  private closePromise: Promise<void> | null = null

  private constructor(
    private readonly pool: PoolPort,
    private readonly ownsPool: boolean,
  ) {}

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

    let transactionStarted = false
    let releaseError: Error | undefined
    let activeStatementIndex: number | null = null
    try {
      await client.query(
        mode !== 'read' ? 'BEGIN' : schemaVersionRead ? BEGIN_VERSION_READ : BEGIN_READ,
      )
      transactionStarted = true

      if (transactionLock !== undefined) {
        await acquireTransactionLock(client, transactionLock)
      }

      const results: SqlResult[] = []
      for (const [statementIndex, statement] of prepared.entries()) {
        // Each statement is a round trip here. One whose gating statement wrote no row
        // cannot match a row (`SqlStatement.skipUnlessWrote`), so it is not sent.
        const gate = statement.skipUnlessWrote
        if (gate !== undefined && results[gate]?.rowsAffected === 0) {
          results.push({ rows: [], rowsAffected: 0 })
          continue
        }
        activeStatementIndex = statementIndex
        const result = await client.query<Record<string, unknown>>(statement.sql, statement.args)
        activeStatementIndex = null
        results.push(normalizeResult(result))
      }
      await client.query('COMMIT')
      transactionStarted = false
      return results
    } catch (error) {
      const failedSchemaVersionRead = schemaVersionRead && activeStatementIndex === 0
      activeStatementIndex = null
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
      throw classifyError(error, label, failedSchemaVersionRead)
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

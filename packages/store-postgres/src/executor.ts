import {
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  StoreUnavailableError,
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
}

class PostgresResultContractError extends TypeError {}

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
    return { sql: compiled.sql, args: [...statement.args] }
  })
}

function normalizeInt8(value: unknown, column: string): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) return BigInt(value)
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
    const pool = new Pool(typeof config === 'string' ? { connectionString: config } : config)
    return new PgExecutor(pool, true)
  }

  static fromPool(pool: Pool): PgExecutor {
    return new PgExecutor(pool, false)
  }

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    mode: SqlBatchMode = 'write',
  ): Promise<SqlResult[]> {
    const prepared = prepareStatements(label, statements)
    if (prepared.length === 0) return []
    const schemaVersionRead = isSchemaVersionRead(label, statements, mode)

    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch (error) {
      throw classifyError(error, label, false)
    }

    let transactionStarted = false
    let releaseError: Error | undefined
    let activeStatementIndex: number | null = null
    try {
      await client.query(
        mode === 'read' ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      )
      transactionStarted = true

      const results: SqlResult[] = []
      for (const [statementIndex, statement] of prepared.entries()) {
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
      client.release(releaseError)
    }
  }

  close(): Promise<void> {
    if (!this.ownsPool) return Promise.resolve()
    this.closePromise ??= this.pool.end()
    return this.closePromise
  }
}

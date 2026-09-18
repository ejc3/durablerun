import { EventEmitter } from 'node:events'
import {
  SchemaMismatchError,
  SchemaNotInitializedError,
  StoreUnavailableError,
} from '@durablerun/core'
import { DatabaseError, type FieldDef, type Pool, type QueryResult } from 'pg'
import { describe, expect, it } from 'vitest'
import { PgExecutor } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'

const EMPTY_RESULT: QueryResult<Record<string, unknown>> = {
  command: '',
  rowCount: null,
  oid: 0,
  fields: [],
  rows: [],
}

function field(name: string, dataTypeID: number): FieldDef {
  return {
    name,
    dataTypeID,
    tableID: 0,
    columnID: 0,
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 'text',
  }
}

function result(
  rows: Record<string, unknown>[],
  fields: FieldDef[],
  rowCount: number | null = rows.length,
): QueryResult<Record<string, unknown>> {
  return { command: '', rowCount, oid: 0, fields, rows }
}

function databaseError(code: string, message = 'database rejected query'): DatabaseError {
  const error = new DatabaseError(message, 0, 'error')
  error.code = code
  return error
}

interface QueryCall {
  text: string
  args: unknown[] | undefined
}

class FakeClient extends EventEmitter {
  readonly calls: QueryCall[] = []
  readonly releases: (Error | boolean | undefined)[] = []

  constructor(
    private readonly respond: (
      text: string,
      args: unknown[] | undefined,
    ) => QueryResult<Record<string, unknown>> | Promise<QueryResult<Record<string, unknown>>>,
  ) {
    super()
  }

  async query(text: string, args?: unknown[]): Promise<QueryResult<Record<string, unknown>>> {
    this.calls.push({ text, args })
    return this.respond(text, args)
  }

  release(error?: Error | boolean): void {
    this.releases.push(error)
  }
}

class FakePool {
  connectCalls = 0
  endCalls = 0

  constructor(
    private readonly client: FakeClient,
    private readonly connectError?: Error,
  ) {}

  async connect(): Promise<FakeClient> {
    this.connectCalls += 1
    if (this.connectError !== undefined) throw this.connectError
    return this.client
  }

  async end(): Promise<void> {
    this.endCalls += 1
  }
}

function executor(pool: FakePool): PgExecutor {
  return PgExecutor.fromPool(pool as unknown as Pool)
}

describe('PgExecutor transactions', () => {
  it('runs a write batch sequentially on one checked-out client', async () => {
    const client = new FakeClient((text) => {
      if (text === `SELECT 'first' AS value`) {
        return result([{ value: 'first' }], [field('value', 25)])
      }
      if (text === `SELECT 'second' AS value`) {
        return result([{ value: 'second' }], [field('value', 25)])
      }
      return EMPTY_RESULT
    })
    const pool = new FakePool(client)

    const results = await executor(pool).batch('ordered', [
      { sql: `SELECT 'first' AS value`, args: [] },
      { sql: `SELECT 'second' AS value`, args: [] },
    ])

    expect(pool.connectCalls).toBe(1)
    expect(client.calls).toEqual([
      { text: 'BEGIN', args: undefined },
      { text: `SELECT 'first' AS value`, args: [] },
      { text: `SELECT 'second' AS value`, args: [] },
      { text: 'COMMIT', args: undefined },
    ])
    expect(results.map((entry) => entry.rows[0]?.value)).toEqual(['first', 'second'])
    expect(client.releases).toEqual([undefined])
  })

  it('uses one repeatable-read, read-only snapshot for a read batch', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)
    const pool = new FakePool(client)

    await executor(pool).batch('read-snapshot', [{ sql: 'SELECT 1', args: [] }], 'read')

    expect(client.calls.map(({ text }) => text)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT 1',
      'COMMIT',
    ])
    expect(pool.connectCalls).toBe(1)
  })

  it('reads the schema version under READ COMMITTED, whose snapshot follows the name lookup', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)

    await executor(new FakePool(client)).batch(
      'migrate:version',
      [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
      'read',
    )

    expect(
      client.calls.map(({ text }) => text),
      'mutation-verdict:construction:postgres-version-read-isolation',
    ).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY',
      SCHEMA_VERSION_READ_SQL,
      'COMMIT',
    ])
  })

  it('skips a statement whose gating statement wrote no row, and answers it with no rows', async () => {
    const sent = async (gateRows: number) => {
      const client = new FakeClient((text) =>
        text === 'UPDATE gate' ? result([], [], gateRows) : result([], [], 7),
      )
      const results = await executor(new FakePool(client)).batch('gated', [
        { sql: 'UPDATE gate', args: [] },
        { sql: 'UPDATE follows_gate', args: [], skipUnlessWrote: 0 },
        { sql: 'UPDATE follows_the_follower', args: [], skipUnlessWrote: 1 },
        { sql: 'UPDATE ungated', args: [] },
      ])
      return {
        texts: client.calls.map(({ text }) => text),
        rowsAffected: results.map((entry) => entry.rowsAffected),
      }
    }
    expect({ lost: await sent(0), won: await sent(1) }).toEqual({
      lost: {
        texts: ['BEGIN', 'UPDATE gate', 'UPDATE ungated', 'COMMIT'],
        rowsAffected: [0, 0, 0, 7],
      },
      won: {
        texts: [
          'BEGIN',
          'UPDATE gate',
          'UPDATE follows_gate',
          'UPDATE follows_the_follower',
          'UPDATE ungated',
          'COMMIT',
        ],
        rowsAffected: [1, 7, 7, 7],
      },
    })
  })

  it('refuses a gate that does not name an earlier statement', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)
    const refusals = []
    for (const skipUnlessWrote of [0, 1, -1, 0.5]) {
      refusals.push(
        await executor(new FakePool(client))
          .batch('bad-gate', [{ sql: 'UPDATE follows', args: [], skipUnlessWrote }])
          .then(
            () => 'accepted',
            (error: unknown) => (error instanceof Error ? error.name : String(error)),
          ),
      )
    }
    expect({ refusals, sent: client.calls.length }).toEqual({
      refusals: ['TypeError', 'TypeError', 'TypeError', 'TypeError'],
      sent: 0,
    })
  })

  it('acquires a scoped event advisory lock before protocol SQL without durable garbage', async () => {
    const client = new FakeClient((text) => {
      if (text === 'SELECT value FROM protocol_state') {
        return result([{ value: 'ready' }], [field('value', 25)])
      }
      return EMPTY_RESULT
    })

    const results = await executor(new FakePool(client)).batch(
      'locked-event',
      [{ sql: 'SELECT value FROM protocol_state', args: [] }],
      {
        mode: 'write',
        transactionLock: { kind: 'event', queue: 'q', eventName: `e'; SELECT 1; --` },
      },
    )

    expect(client.calls.map(({ text }) => text.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN',
      "SELECT pg_advisory_xact_lock(hashtextextended( jsonb_build_array( current_database(), current_schema(), 'durablerun:event', $1::text, $2::text )::text, 0 ))",
      'SELECT value FROM protocol_state',
      'COMMIT',
    ])
    expect(client.calls[1]?.args).toEqual(['q', `e'; SELECT 1; --`])
    expect(results).toEqual([{ rows: [{ value: 'ready' }], rowsAffected: 1 }])
  })

  it('acquires a scoped claim advisory lock before protocol SQL without durable garbage', async () => {
    const client = new FakeClient((text) => {
      if (text === 'SELECT value FROM protocol_state') {
        return result([{ value: 'ready' }], [field('value', 25)])
      }
      return EMPTY_RESULT
    })

    const results = await executor(new FakePool(client)).batch(
      'locked-claim',
      [{ sql: 'SELECT value FROM protocol_state', args: [] }],
      {
        mode: 'write',
        transactionLock: {
          kind: 'claim',
          queue: 'q',
          claimToken: `receipt'; SELECT 1; --`,
        },
      },
    )

    expect(client.calls.map(({ text }) => text.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN',
      "SELECT pg_advisory_xact_lock(hashtextextended( jsonb_build_array( current_database(), current_schema(), 'durablerun:claim', $1::text, $2::text )::text, 0 ))",
      'SELECT value FROM protocol_state',
      'COMMIT',
    ])
    expect(client.calls[1]?.args).toEqual(['q', `receipt'; SELECT 1; --`])
    expect(results).toEqual([{ rows: [{ value: 'ready' }], rowsAffected: 1 }])
  })

  it('rolls back the same client before releasing it after a failed statement', async () => {
    const failure = databaseError('40001', 'serialization failure')
    const client = new FakeClient((text) => {
      if (text === 'UPDATE t SET v = 1') throw failure
      return EMPTY_RESULT
    })
    const pool = new FakePool(client)

    await expect(
      executor(pool).batch('failed-write', [{ sql: 'UPDATE t SET v = 1', args: [] }]),
    ).rejects.toMatchObject({
      name: 'StoreUnavailableError',
      message: expect.stringContaining('SQLSTATE 40001'),
      cause: failure,
    })
    expect(client.calls.map(({ text }) => text)).toEqual([
      'BEGIN',
      'UPDATE t SET v = 1',
      'ROLLBACK',
    ])
    expect(client.releases).toEqual([undefined])
  })

  it('discards a client whose rollback also fails', async () => {
    const queryFailure = databaseError('40001')
    const rollbackFailure = new Error('connection lost during rollback')
    const client = new FakeClient((text) => {
      if (text === 'UPDATE t SET v = 1') throw queryFailure
      if (text === 'ROLLBACK') throw rollbackFailure
      return EMPTY_RESULT
    })

    await expect(
      executor(new FakePool(client)).batch('failed-rollback', [
        { sql: 'UPDATE t SET v = 1', args: [] },
      ]),
    ).rejects.toBeInstanceOf(StoreUnavailableError)
    expect(client.releases).toEqual([rollbackFailure])
  })

  it('returns an empty batch without checking out a client', async () => {
    const pool = new FakePool(new FakeClient(() => EMPTY_RESULT))
    await expect(executor(pool).batch('empty', [])).resolves.toEqual([])
    expect(pool.connectCalls).toBe(0)
  })
})

describe('PgExecutor primitive normalization', () => {
  it('compiles binds and normalizes int8, bytea, and row counts at the source', async () => {
    const bytes = Buffer.from([1, 2, 3, 255])
    const client = new FakeClient((text, args) => {
      if (text === 'UPDATE t SET value = $1 WHERE id = $2 RETURNING count, safe_count, bytes') {
        expect(args).toEqual(['next', 7n])
        return result(
          [{ count: '9007199254740993', safe_count: '42', bytes }],
          [field('count', 20), field('safe_count', 20), field('bytes', 17)],
        )
      }
      if (text === 'UPDATE t SET value = $1') return result([], [], 4)
      return EMPTY_RESULT
    })
    const db = executor(new FakePool(client))

    const [returning, plain] = await db.batch('normalize', [
      {
        sql: 'UPDATE t SET value = ? WHERE id = ? RETURNING count, safe_count, bytes',
        args: ['next', 7n],
      },
      { sql: 'UPDATE t SET value = ?', args: ['final'] },
    ])

    expect(returning).toEqual({
      rows: [{ count: 9007199254740993n, safe_count: 42, bytes: new Uint8Array([1, 2, 3, 255]) }],
      rowsAffected: 1,
    })
    expect(returning?.rows[0]?.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(returning?.rows[0]?.bytes)).toBe(false)
    expect(plain).toEqual({ rows: [], rowsAffected: 4 })
  })

  it('rejects undefined and bind-count mismatches before acquiring a client', async () => {
    const pool = new FakePool(new FakeClient(() => EMPTY_RESULT))
    const db = executor(pool)

    await expect(
      db.batch('undefined', [{ sql: 'SELECT ?', args: [undefined] } as never]),
    ).rejects.toThrow('argument 0 is undefined')
    await expect(db.batch('too-few', [{ sql: 'SELECT ?, ?', args: [1] }])).rejects.toThrow(
      'has 2 placeholders but 1 arguments',
    )
    await expect(db.batch('too-many', [{ sql: 'SELECT ?', args: [1, 2] }])).rejects.toThrow(
      'has 1 placeholders but 2 arguments',
    )
    expect(pool.connectCalls).toBe(0)
  })
})

describe('PgExecutor error classification', () => {
  it('classifies only the canonical missing-meta read as uninitialized', async () => {
    const missing = databaseError('42P01', 'relation "meta" does not exist')
    const client = new FakeClient((text) => {
      if (!text.startsWith('BEGIN ')) throw missing
      return EMPTY_RESULT
    })
    const db = executor(new FakePool(client))

    await expect(
      db.batch('migrate:version', [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }], 'read'),
    ).rejects.toBeInstanceOf(SchemaNotInitializedError)
  })

  it('does not let a transaction-control failure impersonate a fresh database', async () => {
    const failure = databaseError('42P01', 'proxy rejected transaction setup')
    const client = new FakeClient(() => {
      throw failure
    })

    await expect(
      executor(new FakePool(client)).batch(
        'migrate:version',
        [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
        'read',
      ),
    ).rejects.toBeInstanceOf(SchemaMismatchError)
  })

  it('classifies missing relations and columns elsewhere as schema mismatches', async () => {
    for (const code of ['42P01', '42703']) {
      const client = new FakeClient((text) => {
        if (text !== 'BEGIN') throw databaseError(code)
        return EMPTY_RESULT
      })
      const outcome = executor(new FakePool(client)).batch('engine-transition', [
        { sql: 'UPDATE missing SET gone = 1', args: [] },
      ])
      await expect(outcome).rejects.toBeInstanceOf(SchemaMismatchError)
      await expect(outcome).rejects.toMatchObject({
        message: expect.stringContaining(`SQLSTATE ${code}`),
      })
    }
  })

  it('classifies connection and retryable SQLSTATE failures as unavailable', async () => {
    const connectionFailure = new Error('offline')
    await expect(
      executor(new FakePool(new FakeClient(() => EMPTY_RESULT), connectionFailure)).batch(
        'connect',
        [{ sql: 'SELECT 1', args: [] }],
        'read',
      ),
    ).rejects.toMatchObject({ name: 'StoreUnavailableError', cause: connectionFailure })

    const retryable = databaseError('40001', 'serialization failure')
    const client = new FakeClient((text) => {
      if (text !== 'BEGIN') throw retryable
      return EMPTY_RESULT
    })
    await expect(
      executor(new FakePool(client)).batch('retryable', [{ sql: 'UPDATE t SET v = 1', args: [] }]),
    ).rejects.toMatchObject({ name: 'StoreUnavailableError', cause: retryable })
  })

  it('does not reclassify a malformed PostgreSQL result as an outage', async () => {
    const client = new FakeClient((text) => {
      if (text === 'SELECT flag') return result([{ flag: true }], [field('flag', 16)])
      return EMPTY_RESULT
    })
    await expect(
      executor(new FakePool(client)).batch(
        'bad-result',
        [{ sql: 'SELECT flag', args: [] }],
        'read',
      ),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe('PgExecutor pool ownership', () => {
  it('does not close a borrowed pool', async () => {
    const pool = new FakePool(new FakeClient(() => EMPTY_RESULT))
    await executor(pool).close()
    expect(pool.endCalls).toBe(0)
  })

  it('can close an unopened owned pool idempotently', async () => {
    const db = PgExecutor.open({ connectionString: 'postgresql://localhost/unused' })
    await db.close()
    await db.close()
  })
})

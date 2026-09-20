import { EventEmitter } from 'node:events'
import {
  FencedBatch,
  MIGRATION_WRITE,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlTransactionLock,
  StoreUnavailableError,
  prepareRead,
  refusalStateRead,
} from '@durablerun/core'
import { DatabaseError, type FieldDef, type Pool, type QueryResult } from 'pg'
import { describe, expect, it } from 'vitest'
import { PgExecutor } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'
import { TREE_DIALECT } from '../src/tree.js'

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
  /** Set when the statement was sent as a config object that names a protocol. */
  queryMode?: string
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

  /** A pg client takes a text with its values, or one config object, as a read sent alone is. */
  async query(
    sent: string | { text: string; values?: unknown[]; queryMode?: string },
    values?: unknown[],
  ): Promise<QueryResult<Record<string, unknown>>> {
    const text = typeof sent === 'string' ? sent : sent.text
    const args = typeof sent === 'string' ? values : sent.values
    this.calls.push(
      typeof sent === 'string' || sent.queryMode === undefined
        ? { text, args }
        : { text, args, queryMode: sent.queryMode },
    )
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

const REFUSAL_STATE = prepareRead({ runId: 'string' }, (binds: { runId: string }) =>
  refusalStateRead(binds),
)

/** Reads as core's read path builds them, the one kind of statement an executor knows for a read. */
function readsFromCore(...names: string[]): FencedBatch {
  const batch = new FencedBatch('reads', 'seed', { now: 'CLOCK', tree: TREE_DIALECT })
  for (const name of names) batch.readPrepared(name, REFUSAL_STATE, { runId: name })
  return batch
}

/** What was sent, with each read that core built named for what it is. */
const namingReads = (sent: readonly string[]) =>
  sent.map((sql) => (sql.startsWith('select "state" from "runs"') ? 'a read core built' : sql))

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

  it('sends a read that core built alone, outside a transaction block', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)
    await readsFromCore('first').run(executor(new FakePool(client)))
    expect(namingReads(client.calls.map(({ text }) => text))).toEqual(['a read core built'])
    // Through the extended protocol, which takes one statement whatever the text holds.
    expect(client.calls.map(({ queryMode }) => queryMode)).toEqual(['extended'])
    expect(client.releases).toEqual([undefined])
  })

  it('gives two reads that core built one repeatable-read, read-only snapshot', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)
    await readsFromCore('first', 'second').run(executor(new FakePool(client)))
    expect(
      namingReads(client.calls.map(({ text }) => text)),
      'mutation-verdict:construction:postgres-lone-statement-is-the-whole-batch',
    ).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'a read core built',
      'a read core built',
      'COMMIT',
    ])
  })

  it('keeps the transaction around a single write', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)
    await executor(new FakePool(client)).batch('single-write', [
      { sql: 'UPDATE t SET v = ?', args: ['x'] },
    ])
    expect(client.calls.map(({ text }) => text)).toEqual(['BEGIN', 'UPDATE t SET v = $1', 'COMMIT'])
  })

  it('sends nothing after a read sent alone that failed, and releases its client', async () => {
    // PostgreSQL ran the statement in a transaction of its own and aborted it, so the
    // client holds no open transaction to roll back.
    const failure = databaseError('40001', 'serialization failure')
    const client = new FakeClient(() => {
      throw failure
    })
    await expect(readsFromCore('first').run(executor(new FakePool(client)))).rejects.toMatchObject({
      name: 'StoreUnavailableError',
      cause: failure,
    })
    expect(namingReads(client.calls.map(({ text }) => text))).toEqual(['a read core built'])
    expect(client.releases).toEqual([undefined])
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
    expect(
      { lost: await sent(0), won: await sent(1) },
      'mutation-verdict:behavior:postgres-skips-a-gated-statement',
    ).toEqual({
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

  it('runs a batch again when PostgreSQL chose it as a deadlock victim, and gives up after three', async () => {
    const run = async (
      deadlocksBeforeSuccess: number,
      code = '40P01',
      mode: 'write' | 'read' = 'write',
    ) => {
      let attempts = 0
      const client = new FakeClient((text) => {
        if (text !== 'UPDATE contended') return EMPTY_RESULT
        attempts += 1
        if (attempts <= deadlocksBeforeSuccess) throw databaseError(code, 'aborted')
        return result([], [], 1)
      })
      const outcome = await executor(new FakePool(client))
        .batch('contended', [{ sql: 'UPDATE contended', args: [] }], mode)
        .then(
          (results) => results.map((entry) => entry.rowsAffected),
          (error: unknown) => (error instanceof Error ? error.name : String(error)),
        )
      return { outcome, texts: client.calls.map(({ text }) => text) }
    }
    const once = ['BEGIN', 'UPDATE contended', 'ROLLBACK']
    expect(
      {
        victimOnce: await run(1),
        victimAlways: await run(99),
        anotherError: await run(1, '23505'),
        victimOnceInARead: (await run(1, '40P01', 'read')).outcome,
      },
      'mutation-verdict:behavior:postgres-deadlock-victim-runs-again',
    ).toEqual({
      victimOnce: { outcome: [1], texts: [...once, 'BEGIN', 'UPDATE contended', 'COMMIT'] },
      victimAlways: { outcome: 'StoreUnavailableError', texts: [...once, ...once, ...once] },
      // Only a deadlock is run again. Any other failure is reported the first time.
      anotherError: { outcome: 'StoreUnavailableError', texts: once },
      // A read is run again like a write. It takes table locks, so it can be the victim.
      victimOnceInARead: [1],
    })
  })

  it('counts every deadlock victim, the one it runs again and the one it reports', async () => {
    const counted = async (
      batches: readonly {
        deadlocks: number
        mode?: 'read' | 'write'
        code?: string
        rollbackFails?: true
      }[],
    ) => {
      let failuresLeft = 0
      let code = '40P01'
      let rollbackFails = false
      const client = new FakeClient((text) => {
        if (text === 'ROLLBACK' && rollbackFails) throw new Error('connection lost')
        if (text !== 'UPDATE contended' || failuresLeft === 0) return EMPTY_RESULT
        failuresLeft -= 1
        throw databaseError(code, 'aborted')
      })
      const pg = executor(new FakePool(client))
      for (const batch of batches) {
        failuresLeft = batch.deadlocks
        code = batch.code ?? '40P01'
        rollbackFails = batch.rollbackFails === true
        await pg
          .batch('contended', [{ sql: 'UPDATE contended', args: [] }], batch.mode ?? 'write')
          .catch(() => undefined)
      }
      return pg.deadlocks
    }
    expect(
      {
        none: await counted([{ deadlocks: 0 }]),
        runAgain: await counted([{ deadlocks: 2 }]),
        reported: await counted([{ deadlocks: 99 }]),
        // A read batch is never run again, and its victim is counted all the same.
        inAReadBatch: await counted([{ deadlocks: 1, mode: 'read' }]),
        anotherError: await counted([{ deadlocks: 1, code: '23505' }]),
        acrossBatches: await counted([{ deadlocks: 2 }, { deadlocks: 0 }, { deadlocks: 1 }]),
        // A victim whose rollback then fails is reported, and it is a victim all the same.
        rollbackFails: await counted([{ deadlocks: 1, rollbackFails: true }]),
      },
      'mutation-verdict:behavior:postgres-deadlock-victims-are-counted',
    ).toEqual({
      none: 0,
      runAgain: 2,
      reported: 3,
      inAReadBatch: 1,
      anotherError: 0,
      acrossBatches: 3,
      rollbackFails: 1,
    })
  })

  it('refuses a gate that does not name an earlier statement', async () => {
    const client = new FakeClient(() => EMPTY_RESULT)
    const refusals: Record<string, string> = {}
    // The gate rides on the second statement, so each rule has an input only it refuses.
    for (const [why, skipUnlessWrote] of [
      ['itself', 1],
      ['a later one', 2],
      ['a negative index', -1],
      ['a fraction', 0.5],
      ['the first', 0],
    ] as const) {
      refusals[why] = await executor(new FakePool(client))
        .batch('gate', [
          { sql: 'UPDATE first', args: [] },
          { sql: 'UPDATE follows', args: [], skipUnlessWrote },
        ])
        .then(
          () => 'accepted',
          (error: unknown) => (error instanceof Error ? error.name : String(error)),
        )
    }
    expect(refusals, 'mutation-verdict:behavior:postgres-gate-names-an-earlier-statement').toEqual({
      itself: 'TypeError',
      'a later one': 'TypeError',
      'a negative index': 'TypeError',
      'a fraction': 'TypeError',
      'the first': 'accepted',
    })
  })

  it('acquires the event row lock before protocol SQL without adding a result', async () => {
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

    expect(
      client.calls.map(({ text }) => text.replace(/\s+/g, ' ').trim()),
      'mutation-verdict:behavior:postgres-port-event-lock-is-the-row',
    ).toEqual([
      'BEGIN',
      'INSERT INTO event_locks (queue, event_name) VALUES ($1, $2) ON CONFLICT (queue, event_name) DO NOTHING',
      'SELECT 1 FROM event_locks WHERE queue = $1 AND event_name = $2 FOR UPDATE',
      'SELECT value FROM protocol_state',
      'COMMIT',
    ])
    expect(client.calls.slice(1, 3).map(({ args }) => args)).toEqual([
      ['q', `e'; SELECT 1; --`],
      ['q', `e'; SELECT 1; --`],
    ])
    expect(results).toEqual([{ rows: [{ value: 'ready' }], rowsAffected: 1 }])
  })

  it("locks a task's completion event with a scoped advisory lock, and leaves no row", async () => {
    const client = new FakeClient(() => EMPTY_RESULT)

    await executor(new FakePool(client)).batch(
      'locked-completion-event',
      [{ sql: 'SELECT value FROM protocol_state', args: [] }],
      {
        mode: 'write',
        transactionLock: { kind: 'event', queue: 'q', eventName: '$task-done:t1' },
      },
    )

    expect(
      client.calls.map(({ text }) => text.replace(/\s+/g, ' ').trim()),
      'mutation-verdict:behavior:postgres-event-lock-is-advisory',
    ).toEqual([
      'BEGIN',
      "SELECT pg_advisory_xact_lock(hashtextextended( jsonb_build_array( 'durablerun:event', 'events'::regclass::oid::text, $1::text, $2::text )::text, 0 ))",
      'SELECT value FROM protocol_state',
      'COMMIT',
    ])
    expect(client.calls[1]?.args).toEqual(['q', '$task-done:t1'])
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

  it("takes the version table's lock ahead of a migration write's statements, as the released build sent it", async () => {
    // The released build sent this lock as the first statement of each version's batch. It
    // is the control's now, and what reaches the server is the same text in the same place,
    // with no bind, so a migrator of either build waits for the other's.
    const client = new FakeClient(() => EMPTY_RESULT)
    await executor(new FakePool(client)).batch(
      'migrate:v1',
      [{ sql: "INSERT INTO meta (key, value) VALUES ('applied:v1', '1')", args: [] }],
      MIGRATION_WRITE,
    )
    expect(client.calls.map(({ text, args }) => [text, args ?? []])).toEqual([
      ['BEGIN', []],
      ['LOCK TABLE meta IN SHARE ROW EXCLUSIVE MODE', []],
      ["INSERT INTO meta (key, value) VALUES ('applied:v1', '1')", []],
      ['COMMIT', []],
    ])
  })

  it('refuses a migration write that names no migration lock, the bootstrap excepted, and sends nothing', async () => {
    // The lock that makes a second migrator wait was a statement of every version's batch,
    // which no wrapper could drop. It is the control's now, and a wrapper that rebuilds a
    // control from a mode drops it: the batch would then run with no lock on meta, and a
    // second migrator would deadlock with a version that locks the table. The bootstrap
    // names no lock, because the lock lives on the table it creates.
    const sent = async (label: string) => {
      const client = new FakeClient(() => EMPTY_RESULT)
      const pool = new FakePool(client)
      const outcome = await executor(pool)
        .batch(label, [{ sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] }])
        .then(
          () => 'accepted',
          (error: unknown) =>
            error instanceof TypeError ? `refused: ${error.message}` : `failed: ${String(error)}`,
        )
      return { outcome, statements: client.calls.length, connections: pool.connectCalls }
    }
    expect(
      {
        aVersion: await sent('migrate:v1'),
        aLabelNoListKnows: await sent('migrate:backfill'),
        theBootstrap: await sent('migrate:bootstrap'),
      },
      'mutation-verdict:construction:postgres-migration-write-names-its-lock',
    ).toEqual({
      aVersion: {
        outcome: expect.stringContaining('names no migration lock'),
        statements: 0,
        connections: 0,
      },
      aLabelNoListKnows: {
        outcome: expect.stringContaining('names no migration lock'),
        statements: 0,
        connections: 0,
      },
      theBootstrap: { outcome: 'accepted', statements: 3, connections: 1 },
    })
  })

  it('refuses a lock of a kind it does not implement, and sends nothing', async () => {
    // A lock kind is added by a later build of core, and an executor of this build can
    // meet it. Taken for a kind it knows, the batch runs under the wrong lock, or under one
    // keyed on coordinates that are not there. Ignored, it runs under none.
    const client = new FakeClient(() => EMPTY_RESULT)
    const pool = new FakePool(client)
    const outcome = await executor(pool)
      .batch('a-later-protocol', [{ sql: 'UPDATE t SET v = 1', args: [] }], {
        mode: 'write',
        transactionLock: { kind: 'a kind of a later build' } as unknown as SqlTransactionLock,
      })
      .then(
        () => 'accepted',
        (error: unknown) => error,
      )
    const refusal =
      outcome instanceof TypeError ? outcome.message : `not refused: ${String(outcome)}`
    expect(
      {
        refusal,
        sent: client.calls.map(({ text }) => text.replace(/\s+/g, ' ').trim()),
        connections: pool.connectCalls,
      },
      'mutation-verdict:construction:postgres-lock-of-an-unknown-kind-is-refused',
    ).toEqual({
      refusal: expect.stringContaining('a kind of a later build'),
      sent: [],
      connections: 0,
    })
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

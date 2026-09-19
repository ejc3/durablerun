import { StoreUnavailableError } from '@durablerun/core'
import type { FieldPacket, Pool } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'

const OK = [{ affectedRows: 0, info: '' }, undefined] as const
const rows = (values: Record<string, unknown>[], name: string) =>
  [values, [{ name, columnType: 253 } as unknown as FieldPacket]] as const

/** A connection that records what it is sent and answers what a server would. */
class FakeConnection {
  readonly sent: string[] = []
  /** What the server answers a statement with, where a test cares. */
  readonly headers = new Map<string, { affectedRows: number; info: string }>()
  /** Statements the server fails, and how many more times it will. */
  readonly failures = new Map<string, { error: unknown; times: number }>()

  private failIfToldTo(sql: string): void {
    const failure = this.failures.get(sql)
    if (failure === undefined || failure.times === 0) return
    failure.times -= 1
    throw failure.error
  }

  /** What GET_LOCK answers: 1 when taken, 0 when the wait ran out. */
  lockAnswer = 1
  released = 0

  /** The physical connection under a pool's wrapper, as mysql2 exposes it. */
  readonly connection = {}

  async query(sql: string) {
    this.sent.push(sql)
    this.failIfToldTo(sql)
    const header = this.headers.get(sql)
    if (header !== undefined) return [header, undefined] as const
    return sql.startsWith('SELECT') ? rows([{ value: '5' }], 'value') : OK
  }

  async execute(sql: string) {
    this.sent.push(sql)
    this.failIfToldTo(sql)
    return sql.includes('GET_LOCK') ? rows([{ acquired: this.lockAnswer }], 'acquired') : OK
  }

  release() {
    this.released += 1
  }

  destroyed = 0

  destroy() {
    this.destroyed += 1
  }
}

/** The part of a mysql2 pool that records the handshake flags it connects with. */
const OWNED_POOL_CONFIG = {
  config: { resetOnRelease: false, connectionConfig: { clientFlags: 0 } },
}

function executorOver(connection: FakeConnection): MysqlExecutor {
  const pool = {
    getConnection: async () => connection,
    end: async () => undefined,
    pool: OWNED_POOL_CONFIG,
  }
  return MysqlExecutor.fromPool(pool as unknown as Pool)
}

/** What a batch sent after the session settings every new connection gets first. */
const afterSessionSetup = (connection: FakeConnection) =>
  connection.sent.filter((sql) => !sql.startsWith('SET SESSION'))

describe('MysqlExecutor transactions', () => {
  it('reads the schema version under READ COMMITTED, with no snapshot taken ahead of the statement', async () => {
    const connection = new FakeConnection()
    const results = await executorOver(connection).batch(
      'migrate:version',
      [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
      'read',
    )
    expect(results).toEqual([{ rows: [{ value: '5' }], rowsAffected: 1 }])
    expect(
      afterSessionSetup(connection),
      'mutation-verdict:construction:mysql-version-read-is-read-committed',
      // Alone, under the session's READ COMMITTED. No transaction is begun, so nothing
      // takes a snapshot ahead of the statement.
    ).toEqual([SCHEMA_VERSION_READ_SQL])
    expect(connection.released).toBe(1)
  })

  it('sends a batch of one statement alone, with no transaction around it', async () => {
    const read = new FakeConnection()
    await executorOver(read).batch('next-wake', [{ sql: 'SELECT 1 AS value', args: [] }], 'read')
    expect(afterSessionSetup(read)).toEqual(['SELECT 1 AS value'])
    const write = new FakeConnection()
    await executorOver(write).batch('fixture:write', [{ sql: 'UPDATE t SET a = ?', args: ['x'] }])
    expect(afterSessionSetup(write)).toEqual(['UPDATE t SET a = ?'])
    expect(read.released + write.released).toBe(2)
  })

  it('gives a read batch of more than one statement one consistent read-only snapshot', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch(
      'sweep:scan',
      [
        { sql: 'SELECT 1 AS value', args: [] },
        { sql: 'SELECT 2 AS value', args: [] },
      ],
      'read',
    )
    expect(
      afterSessionSetup(connection),
      'mutation-verdict:construction:mysql-lone-statement-is-the-whole-batch',
    ).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'SELECT 1 AS value',
      'SELECT 2 AS value',
      'COMMIT',
    ])
  })

  it('keeps the read-only transaction for a read that does not begin with SELECT', async () => {
    // The server refuses a write inside it, which is what stands behind a statement the
    // executor cannot prove is a SELECT.
    for (const sql of [
      "DELETE FROM meta WHERE `key` = 'a'",
      'WITH one AS (SELECT 1 AS n) SELECT n FROM one',
    ]) {
      const connection = new FakeConnection()
      await executorOver(connection).batch('fixture:read', [{ sql, args: [] }], 'read')
      expect(afterSessionSetup(connection)).toEqual([
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
        sql,
        'COMMIT',
      ])
    }
  })

  it('keeps the transaction for a single write whose bound string ends in a space', async () => {
    // MySQL cuts trailing spaces past a column's width with a note, and the refusal of a
    // cut write can only precede the commit inside a transaction.
    const connection = new FakeConnection()
    const sql = 'INSERT INTO meta (`key`, value) VALUES (?, ?)'
    await executorOver(connection).batch('fixture:write', [{ sql, args: ['padded ', 'v'] }])
    expect(afterSessionSetup(connection)).toEqual(['START TRANSACTION', sql, 'COMMIT'])
  })

  it('holds the migration lock from before a migration transaction until after it', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch('migrate:v1', [
      { sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] },
    ])
    const sent = afterSessionSetup(connection)
    expect(
      sent.map((sql) =>
        sql.includes('GET_LOCK') ? 'lock' : sql.includes('RELEASE_LOCK') ? 'unlock' : sql,
      ),
      'mutation-verdict:construction:mysql-lone-statement-carries-no-lock',
    ).toEqual([
      'lock',
      'START TRANSACTION',
      'CREATE TABLE IF NOT EXISTS t (a INT)',
      'COMMIT',
      'unlock',
    ])
  })

  it('reports a DELETE of two rows as two rows', async () => {
    // MySQL answers a DELETE with a count and no info line, which is also how it answers
    // a single-row upsert that updated. Only the upsert counts its row twice.
    const connection = new FakeConnection()
    const twoRows = "DELETE FROM meta WHERE `key` IN ('a', 'b')"
    connection.headers.set(twoRows, { affectedRows: 2, info: '' })
    const results = await executorOver(connection).batch('fixture:delete', [
      { sql: twoRows, args: [] },
    ])
    expect(
      results.map(({ rowsAffected }) => rowsAffected),
      'mutation-verdict:construction:mysql-only-an-insert-counts-twice',
    ).toEqual([2])
  })

  it('sends the session settings once for each physical connection', async () => {
    // mysql2's promise pool hands out a new wrapper object on every checkout, over the
    // same physical connection. The settings belong to the connection.
    const connection = new FakeConnection()
    const pool = {
      getConnection: async () => new Proxy(connection, {}),
      end: async () => undefined,
      pool: OWNED_POOL_CONFIG,
    }
    const executor = MysqlExecutor.fromPool(pool as unknown as Pool)
    await executor.batch('next-wake', [{ sql: 'SELECT 1 AS value', args: [] }], 'read')
    await executor.batch('next-wake', [{ sql: 'SELECT 1 AS value', args: [] }], 'read')
    expect(
      connection.sent.filter((sql) => sql.startsWith('SET SESSION')),
      'mutation-verdict:construction:mysql-session-settings-once-per-connection',
    ).toHaveLength(1)
  })

  it('refuses a pool that connects with FOUND_ROWS, or whose flags it cannot read', () => {
    // mysql2 turns FOUND_ROWS on by default. Under it a conflict arm that changed nothing
    // reports one row, and a compare-and-set that lost reads as one that won.
    const over = (pool: unknown) => () =>
      MysqlExecutor.fromPool({
        getConnection: async () => new FakeConnection(),
        end: async () => undefined,
        pool,
      } as unknown as Pool)
    const FOUND_ROWS = 2
    expect(
      over({ config: { connectionConfig: { clientFlags: FOUND_ROWS } } }),
      'mutation-verdict:construction:mysql-foreign-pool-found-rows-refused',
    ).toThrow(/FOUND_ROWS/)
    expect(over(undefined)).toThrow(/FOUND_ROWS/)
    expect(over(OWNED_POOL_CONFIG)).not.toThrow()
  })

  it('reports the store unavailable when a named lock cannot be taken in time, and writes nothing', async () => {
    const connection = new FakeConnection()
    connection.lockAnswer = 0
    const outcome = await executorOver(connection)
      .batch('migrate:v1', [{ sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] }])
      .then(
        () => 'accepted',
        (error: unknown) => error,
      )
    expect(outcome).toBeInstanceOf(StoreUnavailableError)
    expect(String(outcome)).toContain('within 30 seconds')
    expect(afterSessionSetup(connection).filter((sql) => !sql.includes('GET_LOCK'))).toEqual([])
    // The connection leaves the batch exactly once, returned or discarded.
    expect(connection.released + connection.destroyed).toBe(1)
  })

  it('refuses a pool that resets a connection on release, or that does not say', () => {
    // The session settings are sent once for each connection. A reset on release clears
    // them, and every write after the first would run at REPEATABLE READ with no strict mode.
    const over = (config: unknown) => () =>
      MysqlExecutor.fromPool({
        getConnection: async () => new FakeConnection(),
        end: async () => undefined,
        pool: { config },
      } as unknown as Pool)
    expect(
      over({ resetOnRelease: true, connectionConfig: { clientFlags: 0 } }),
      'mutation-verdict:construction:mysql-foreign-pool-reset-on-release-refused',
    ).toThrow(/resets? a connection on release/)
    expect(over({ connectionConfig: { clientFlags: 0 } })).toThrow(
      /resets? a connection on release/,
    )
    expect(over(OWNED_POOL_CONFIG.config)).not.toThrow()
  })

  it('refuses a statement gated by one that is not earlier in its batch', async () => {
    const gatedBy = (gate: number) =>
      executorOver(new FakeConnection())
        .batch('fixture:gate', [
          { sql: 'SELECT 1 AS value', args: [] },
          { sql: 'SELECT 2 AS value', args: [], skipUnlessWrote: gate },
        ])
        .then(
          () => 'accepted',
          (error: unknown) => error,
        )
    for (const gate of [1, 2, -1, 0.5]) expect(await gatedBy(gate)).toBeInstanceOf(TypeError)
    expect(await gatedBy(0)).toBe('accepted')
  })

  describe('a deadlock', () => {
    const DEADLOCK = Object.assign(new Error('Deadlock found when trying to get lock'), {
      errno: 1213,
    })
    const WRITE = 'UPDATE t SET a = 1'
    const READ = 'SELECT a AS value FROM t'
    const shape = (connection: FakeConnection) =>
      afterSessionSetup(connection).map((sql) =>
        sql.includes('GET_LOCK') ? 'lock' : sql.includes('RELEASE_LOCK') ? 'unlock' : sql,
      )

    it('runs a write batch again after a deadlock, under the named lock it already holds', async () => {
      const connection = new FakeConnection()
      connection.failures.set(WRITE, { error: DEADLOCK, times: 2 })
      // The outcome is taken first, so that a batch which is not run again fails the
      // assertion below and not the test's own await.
      const outcome = await executorOver(connection)
        .batch('migrate:v1', [{ sql: WRITE, args: [] }])
        .then(
          (results) => `answered ${results.length} statement`,
          (error: unknown) => error,
        )
      expect(outcome, 'mutation-verdict:construction:mysql-deadlocked-write-batch-runs-again').toBe(
        'answered 1 statement',
      )
      const attempt = ['START TRANSACTION', WRITE, 'ROLLBACK']
      expect(shape(connection)).toEqual([
        'lock',
        ...attempt,
        ...attempt,
        'START TRANSACTION',
        WRITE,
        'COMMIT',
        'unlock',
      ])
      expect(connection.released).toBe(1)
    })

    it('runs a statement sent alone again after a deadlock, with nothing to roll back', async () => {
      const connection = new FakeConnection()
      connection.failures.set(WRITE, { error: DEADLOCK, times: 1 })
      const results = await executorOver(connection).batch('fixture:write', [
        { sql: WRITE, args: [] },
      ])
      expect(results).toHaveLength(1)
      expect(shape(connection)).toEqual([WRITE, WRITE])
      expect(connection.released).toBe(1)
    })

    it('reports the store unavailable after three deadlocks, and returns the connection', async () => {
      const connection = new FakeConnection()
      connection.failures.set(WRITE, { error: DEADLOCK, times: 3 })
      const outcome = await executorOver(connection)
        .batch('fixture:write', [{ sql: WRITE, args: [] }])
        .then(
          () => 'accepted',
          (error: unknown) => error,
        )
      expect(outcome).toBeInstanceOf(StoreUnavailableError)
      expect(String(outcome)).toContain('1213')
      expect(shape(connection).filter((sql) => sql === WRITE)).toHaveLength(3)
      expect(connection.released).toBe(1)
    })

    it('counts every deadlock victim, the one it runs again and the one it reports', async () => {
      const DUPLICATE = Object.assign(new Error('Duplicate entry'), { errno: 1062 })
      const counted = async (
        batches: readonly {
          times: number
          mode?: 'read' | 'write'
          error?: unknown
          rollbackFails?: true
        }[],
      ) => {
        const connection = new FakeConnection()
        const executor = executorOver(connection)
        for (const batch of batches) {
          const sql = batch.mode === 'read' ? READ : WRITE
          connection.failures.set(sql, { error: batch.error ?? DEADLOCK, times: batch.times })
          if (batch.rollbackFails) {
            connection.failures.set('ROLLBACK', { error: new Error('connection lost'), times: 1 })
          }
          await executor
            .batch('fixture:write', [{ sql, args: [] }], batch.mode ?? 'write')
            .catch(() => undefined)
        }
        return executor.deadlocks
      }
      expect(
        {
          none: await counted([{ times: 0 }]),
          runAgain: await counted([{ times: 2 }]),
          reported: await counted([{ times: 99 }]),
          // A read batch is never run again, and its victim is counted all the same.
          inAReadBatch: await counted([{ times: 1, mode: 'read' }]),
          anotherError: await counted([{ times: 1, error: DUPLICATE }]),
          acrossBatches: await counted([{ times: 2 }, { times: 0 }, { times: 1 }]),
          // A victim whose rollback then fails is reported, and it is a victim all the same.
          rollbackFails: await counted([{ times: 1, rollbackFails: true }]),
        },
        'mutation-verdict:behavior:mysql-deadlock-victims-are-counted',
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

    it('does not run a read batch again', async () => {
      const connection = new FakeConnection()
      connection.failures.set(READ, { error: DEADLOCK, times: 1 })
      const outcome = await executorOver(connection)
        .batch('next-wake', [{ sql: READ, args: [] }], 'read')
        .then(
          () => 'accepted',
          (error: unknown) => error,
        )
      expect(outcome).toBeInstanceOf(StoreUnavailableError)
      expect(shape(connection).filter((sql) => sql === READ)).toHaveLength(1)
    })
  })

  it('takes no lock for the version read', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch(
      'migrate:version',
      [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
      'read',
    )
    expect(connection.sent.some((sql) => sql.includes('GET_LOCK'))).toBe(false)
  })
})

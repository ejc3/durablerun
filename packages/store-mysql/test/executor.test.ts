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
    ).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'START TRANSACTION READ ONLY',
      SCHEMA_VERSION_READ_SQL,
      'COMMIT',
    ])
    expect(connection.released).toBe(1)
  })

  it('gives every other read batch one consistent read-only snapshot', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch(
      'next-wake',
      [{ sql: 'SELECT 1 AS value', args: [] }],
      'read',
    )
    expect(afterSessionSetup(connection)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'SELECT 1 AS value',
      'COMMIT',
    ])
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

    it('does not run a read batch again', async () => {
      const connection = new FakeConnection()
      const READ = 'SELECT a AS value FROM t'
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

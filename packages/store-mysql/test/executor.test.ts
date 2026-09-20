import {
  FencedBatch,
  MIGRATION_WRITE,
  type SqlStatement,
  type SqlTransactionLock,
  StoreUnavailableError,
  prepareRead,
  refusalStateRead,
} from '@durablerun/core'
import type { FieldPacket, Pool } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'
import { TREE_DIALECT } from '../src/tree.js'

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
  sent.map((sql) => (sql.startsWith('select `state` from `runs`') ? 'a read core built' : sql))

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
    ).toEqual([SCHEMA_VERSION_READ_SQL])
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

  it('sends a read that core built alone, with no transaction around it', async () => {
    const connection = new FakeConnection()
    await readsFromCore('first').run(executorOver(connection))
    expect(namingReads(afterSessionSetup(connection))).toEqual(['a read core built'])
    expect(connection.released).toBe(1)
  })

  it('gives two reads that core built one consistent read-only snapshot', async () => {
    const connection = new FakeConnection()
    await readsFromCore('first', 'second').run(executorOver(connection))
    expect(
      namingReads(afterSessionSetup(connection)),
      'mutation-verdict:construction:mysql-lone-statement-is-the-whole-batch',
    ).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'a read core built',
      'a read core built',
      'COMMIT',
    ])
  })

  it('decides whether a batch goes alone when it copies the statements, and not from what the array holds later', async () => {
    // The executor copies what it will send, then waits for a connection. A caller that
    // changes its array during that wait must not change what the executor decided: here
    // a delete passed as a read is swapped for a read that core built, and the delete the
    // executor copied must still go inside the read-only transaction that refuses it.
    const branded: SqlStatement[] = []
    await readsFromCore('first').run({
      batch: async (_label, statements) => {
        branded.push(...statements)
        return statements.map(() => ({ rows: [], rowsAffected: 0 }))
      },
    })
    const [read] = branded
    if (read === undefined) throw new Error('core built no read')
    const connection = new FakeConnection()
    const statements: SqlStatement[] = [{ sql: 'DELETE FROM t', args: [] }]
    const pool = {
      getConnection: async () => {
        statements[0] = read
        return connection
      },
      end: async () => undefined,
      pool: OWNED_POOL_CONFIG,
    }
    await MysqlExecutor.fromPool(pool as unknown as Pool).batch('fixture:swap', statements, 'read')
    expect(
      afterSessionSetup(connection),
      'mutation-verdict:construction:mysql-lone-send-is-decided-with-the-copy',
    ).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'DELETE FROM t',
      'COMMIT',
    ])
  })

  it('keeps the transaction around a single write', async () => {
    const connection = new FakeConnection()
    const sql = 'UPDATE t SET a = ?'
    await executorOver(connection).batch('fixture:write', [{ sql, args: ['x'] }])
    expect(afterSessionSetup(connection)).toEqual(['START TRANSACTION', sql, 'COMMIT'])
  })

  it('turns autocommit on with the session settings, which a read sent alone depends on', async () => {
    // With autocommit off, a read sent alone would open a transaction that stays open on
    // the pooled connection it returns.
    const connection = new FakeConnection()
    await readsFromCore('first').run(executorOver(connection))
    expect(connection.sent[0], 'mutation-verdict:construction:mysql-session-autocommit-on').toMatch(
      /^SET SESSION\s+autocommit = 1,/,
    )
  })

  it('holds the migration lock from before a migration transaction until after it', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch(
      'migrate:v1',
      [{ sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] }],
      MIGRATION_WRITE,
    )
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

  it('refuses a migration write that names no migration lock, and sends nothing', async () => {
    // MySQL commits each DDL statement on its own, so a migration write is safe only while
    // no other migrator runs. The batch itself has to name the lock. Chosen from a list of
    // labels, a `migrate:` label the list does not know runs its DDL beside another
    // migrator, and nothing says so.
    const connection = new FakeConnection()
    const outcome = await executorOver(connection)
      .batch('migrate:backfill', [{ sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] }])
      .then(
        () => 'accepted',
        (error: unknown) => error,
      )
    const refusal =
      outcome instanceof TypeError ? outcome.message : `not refused: ${String(outcome)}`
    expect({ refusal, sent: afterSessionSetup(connection) }).toEqual({
      refusal: expect.stringContaining('names no migration lock'),
      sent: [],
    })
  })

  it('refuses a lock of a kind it does not implement, and sends nothing', async () => {
    // A lock kind is added by a later build of core, and an executor of this build can
    // meet it. Taken for a kind it knows, the batch runs under the wrong lock, or under one
    // named from coordinates that are not there. Ignored, it runs under none.
    const connection = new FakeConnection()
    const outcome = await executorOver(connection)
      .batch('a-later-protocol', [{ sql: 'UPDATE t SET a = 1', args: [] }], {
        mode: 'write',
        transactionLock: { kind: 'a kind of a later build' } as unknown as SqlTransactionLock,
      })
      .then(
        () => 'accepted',
        (error: unknown) => error,
      )
    const refusal =
      outcome instanceof TypeError ? outcome.message : `not refused: ${String(outcome)}`
    expect({ refusal, sent: connection.sent }).toEqual({
      refusal: expect.stringContaining('a kind of a later build'),
      sent: [],
    })
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
      .batch(
        'migrate:v1',
        [{ sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] }],
        MIGRATION_WRITE,
      )
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
        .batch('migrate:v1', [{ sql: WRITE, args: [] }], MIGRATION_WRITE)
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

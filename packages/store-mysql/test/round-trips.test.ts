import type { Pool, PoolConnection } from 'mysql2/promise'
import { expect, it } from 'vitest'
import { MysqlStoreAdmin } from '../src/admin.js'
import { MysqlExecutor, createOwnedMysqlPool } from '../src/executor.js'
import { MysqlSchedulerStore } from '../src/store.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * Every query a store call sends is a round trip, with the named lock, START TRANSACTION,
 * and COMMIT among them, and the link to MySQL is the slow part of every batch. A batch
 * of one statement with no lock coordinate is sent as that statement alone, under the
 * session's autocommit, and every other shape keeps its transaction. The counts are
 * pinned here, against a server, for each shape. A query is counted where the executor
 * sends it, so the one extra trip that prepares a statement the first time a connection
 * sees it is left out, as it is from the cost of every later call.
 */
it('sends one query for a read that core built, and a pinned number for every other shape', async () => {
  const url = process.env.DURABLERUN_MYSQL_URL
  if (!url) throw new Error('DURABLERUN_MYSQL_URL is required, as it is for the conformance suite')
  const fixture = await openMysqlTestDb({ idNamespace: 'round-trips', nowMs: 1_000_000 })
  // One connection, so the session settings are sent once, ahead of every measurement.
  const pool = createOwnedMysqlPool({
    uri: url,
    database: fixture.databaseName,
    connectionLimit: 1,
  })
  let sent = 0
  const counting = {
    // `fromPool` reads the handshake flags and the reset rule from the pool under this one.
    pool: (pool as unknown as { pool: unknown }).pool,
    getConnection: async () => {
      const connection = await pool.getConnection()
      const counted = Object.create(connection) as Record<string, unknown>
      for (const send of ['query', 'execute'] as const) {
        const original = connection[send].bind(connection) as (...args: unknown[]) => unknown
        counted[send] = (...args: unknown[]) => {
          sent++
          return original(...args)
        }
      }
      return counted as unknown as PoolConnection
    },
    end: () => pool.end(),
  }
  try {
    const db = MysqlExecutor.fromPool(counting as unknown as Pool)
    const admin = new MysqlStoreAdmin(db)
    const store = new MysqlSchedulerStore(db, fixture.ids)
    const Q = 'q'
    const measure = async (op: () => Promise<unknown>) => {
      const before = sent
      await op()
      return sent - before
    }
    const claimed = async (queue: string, worker: string) => {
      const [run] = await store.claim(queue, worker, { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error(`nothing to claim for ${worker}`)
      return run
    }
    // The connection's first checkout sends the session settings.
    await admin.schemaVersion()

    const versionRead = await measure(() => admin.schemaVersion())
    const spawned = await store.spawn(Q, 'job', '{}')
    const nextWake = await measure(() => store.nextWakeAtEpochMs(Q))
    const taskResult = await measure(() => store.getTaskResult(Q, spawned.taskId))
    const scanNothingDue = await measure(() => store.sweep(Q, 10))
    const claim = await measure(() => claimed(Q, 'w1'))
    await store.spawn(Q, 'second', '{}')
    const run = await claimed(Q, 'w2')
    const activate = await measure(() => store.activate(Q, run.runId, run.claimToken, run.claimGen))
    const beatHeld = await measure(() => store.heartbeat(Q, run.runId, run.claimToken, 30))
    const beatRefused = await measure(() => store.heartbeat(Q, run.runId, 'another-token', 30))
    const checkpoint = await measure(() =>
      store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 'step', '{}', 60),
    )
    const expire = await measure(() => store.expireLeaseNow(Q, run.runId, run.claimToken))
    // A read sent as text is one the executor cannot know for a read, so it keeps the
    // read-only transaction, in which the server refuses a write.
    const textRead = await measure(() =>
      db.batch('fixture:text-read', [{ sql: 'SELECT 1 AS n', args: [] }], 'read'),
    )
    const lockedWrite = await measure(() =>
      db.batch(
        'fixture:locked-write',
        [{ sql: "UPDATE meta SET value = value WHERE `key` = 'absent'", args: [] }],
        { mode: 'write', transactionLock: { kind: 'claim', queue: Q, claimToken: 'fixture' } },
      ),
    )

    expect({
      'the schema version read': versionRead,
      'next-wake, a read of one statement': nextWake,
      'task-result, a read of one statement': taskResult,
      'the sweep scan with nothing due, a read of two statements': scanNothingDue,
      'expire-lease-now, a single write': expire,
      'a read of one statement sent as text': textRead,
      'a single write under a lock coordinate': lockedWrite,
      'claim, a locked batch': claim,
      'activate, a fenced batch': activate,
      'set-checkpoint, a fenced batch': checkpoint,
      'heartbeat, held': beatHeld,
      'heartbeat, refused': beatRefused,
    }).toEqual({
      'the schema version read': 1,
      'next-wake, a read of one statement': 1,
      'task-result, a read of one statement': 1,
      // SET TRANSACTION, START TRANSACTION, the two reads, and COMMIT.
      'the sweep scan with nothing due, a read of two statements': 5,
      // START TRANSACTION, the write, and COMMIT: a write always keeps its transaction.
      'expire-lease-now, a single write': 3,
      'a read of one statement sent as text': 4,
      // The named lock, START TRANSACTION, the write, COMMIT, and the release.
      'a single write under a lock coordinate': 5,
      // The named lock, START TRANSACTION, four statements that were not skipped, COMMIT,
      // and the release. A fenced batch is START TRANSACTION, its statements, and COMMIT.
      'claim, a locked batch': 8,
      'activate, a fenced batch': 5,
      'set-checkpoint, a fenced batch': 4,
      // A held beat is START TRANSACTION, the compare-and-set, the gated read of what is
      // left, and COMMIT. A refused beat skips the gated read, then reads the run's state
      // in a batch of its own, which is one statement.
      'heartbeat, held': 4,
      'heartbeat, refused': 4,
    })
  } finally {
    await pool.end().catch(() => undefined)
    await fixture.close()
  }
}, 60_000)

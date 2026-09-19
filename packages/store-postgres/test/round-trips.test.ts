import {
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  encodeRollbackTry,
} from '@durablerun/core'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PgExecutor, PostgresSchedulerStore, PostgresStoreAdmin } from '../src/index.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * Every query a store call sends is a round trip, with BEGIN, the event lock, and COMMIT
 * among them, and the link to PostgreSQL is the slow part of every batch. A statement
 * whose gate wrote no row is never sent (`SqlStatement.skipUnlessWrote`), so the count
 * depends on which arms of a batch fire, and it is pinned here for each arm a saga adds,
 * and for each shape of batch the executor sends.
 */

interface Counted {
  readonly db: PgExecutor
  readonly admin: PostgresStoreAdmin
  readonly store: PostgresSchedulerStore
  /** How many queries the operation sent. */
  readonly measure: (op: () => Promise<unknown>) => Promise<number>
}

/** A migrated store in a schema of its own, over a pool that counts every query it sends. */
async function counted(name: string, body: (counted: Counted) => Promise<void>): Promise<void> {
  const url = process.env.DURABLERUN_POSTGRES_URL
  if (!url)
    throw new Error('DURABLERUN_POSTGRES_URL is required, as it is for the conformance suite')
  // The fixture owns the schema: it creates and migrates it, sets the clock, and drops it.
  const fixture = await openPostgresTestDb({
    idNamespace: `round-trips-${name}`,
    nowMs: 1_000_000,
  })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${fixture.schemaName}` })
  let sent = 0
  const counted = new WeakSet<object>()
  const counting = {
    connect: async () => {
      const client = await pool.connect()
      if (!counted.has(client)) {
        counted.add(client)
        const query = client.query.bind(client) as (...args: unknown[]) => unknown
        ;(client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          sent++
          return query(...args)
        }
      }
      return client
    },
    end: () => pool.end(),
  }
  try {
    const db = PgExecutor.fromPool(counting as unknown as Pool)
    const admin = new PostgresStoreAdmin(db)
    const store = new PostgresSchedulerStore(db, fixture.ids)
    const measure = async (op: () => Promise<unknown>) => {
      const before = sent
      await op()
      return sent - before
    }
    await body({ db, admin, store, measure })
  } finally {
    await pool.end().catch(() => undefined)
    await fixture.close()
  }
}

/**
 * What a saga costs a task that has none: one query on every failure. The rollback pass
 * is gated on the failure alone, so it is sent, and matches nothing. The store decides
 * whether a rollback is owed from its own rows, and a caller's hint that none is would
 * be a second account of those rows, which a worker of an older build could not give.
 */
it('sends a pinned number of queries for each batch a saga touches, and for a heartbeat', async () => {
  await counted('sagas', async ({ store, measure }) => {
    const Q = 'q'
    const E = '{"name":"E"}'
    // Activated by this store, so a terminal batch already knows its run's task.
    const claimed = async (worker: string) => {
      const [run] = await store.claim(Q, worker, { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error(`nothing to claim for ${worker}`)
      await store.activate(Q, run.runId, run.claimToken, run.claimGen)
      return run
    }
    type Held = { taskId: string; runId: string; claimToken: string }
    const mark = (run: Held, name: string, state: string) =>
      store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, name, state, 60)
    const tried = (tries: number) => ({
      key: `${SAGA_TRIES_PREFIX}a`,
      stateJson: encodeRollbackTry({ tries, errorJson: '{"name":"R"}' }),
    })

    await store.spawn(Q, 'plain', '{}')
    const plain = await claimed('w1')
    const beatHeld = await measure(() => store.heartbeat(Q, plain.runId, plain.claimToken, 30))
    const beatRefused = await measure(() => store.heartbeat(Q, plain.runId, 'another-token', 30))
    const stepCheckpoint = await measure(() => mark(plain, 'step', '{}'))
    const failFinal = await measure(() => store.fail(Q, plain.runId, plain.claimToken, E, null))
    await store.spawn(Q, 'retrying', '{}', { maxAttempts: 3 })
    const retrying = await claimed('w2')
    const failRetrying = await measure(() =>
      store.fail(Q, retrying.runId, retrying.claimToken, E, { delaySeconds: 0 }),
    )
    const again = await claimed('w3')
    const complete = await measure(() => store.complete(Q, again.runId, again.claimToken, '{}'))

    await store.spawn(Q, 'saga', '{}')
    const forward = await claimed('w4')
    const startMarker = await measure(() => mark(forward, `${SAGA_STARTED_PREFIX}a`, '1'))
    await mark(forward, `${SAGA_STARTED_PREFIX}b`, '2')
    const entering = await measure(() => store.fail(Q, forward.runId, forward.claimToken, E, null))
    const pass = await claimed('w5')
    const rollback = await measure(() => mark(pass, `${SAGA_ROLLBACK_PREFIX}b`, 'null'))
    const rollbackRetrying = await measure(() =>
      store.failRollback(Q, pass.runId, pass.claimToken, E, { delaySeconds: 0 }, tried(1)),
    )
    const next = await claimed('w6')
    const rollbackHalts = await measure(() =>
      store.failRollback(Q, next.runId, next.claimToken, E, null, tried(2)),
    )
    await store.spawn(Q, 'finishes', '{}')
    const forward2 = await claimed('w7')
    await mark(forward2, `${SAGA_STARTED_PREFIX}a`, '1')
    await store.fail(Q, forward2.runId, forward2.claimToken, E, null)
    const pass2 = await claimed('w8')
    await mark(pass2, `${SAGA_ROLLBACK_PREFIX}a`, 'null')
    const finishing = await measure(() => store.fail(Q, pass2.runId, pass2.claimToken, E, null))

    expect({
      'heartbeat, held': beatHeld,
      'heartbeat, refused': beatRefused,
      'set-checkpoint of a step': stepCheckpoint,
      'set-checkpoint of a start marker': startMarker,
      'set-checkpoint of a rollback': rollback,
      complete,
      'fail, final, nothing to roll back': failFinal,
      'fail, retrying, nothing to roll back': failRetrying,
      'fail, final, entering the phase': entering,
      'fail, final, finishing the saga': finishing,
      'fail-rollback, retrying': rollbackRetrying,
      'fail-rollback, final': rollbackHalts,
    }).toEqual({
      // A held beat is BEGIN, the compare-and-set, the gated read of what is left, and
      // COMMIT: one query more than the single statement with RETURNING it replaced. A
      // refused beat skips the gated read, then reads the run's state in a batch of its
      // own, which is one statement and so one query.
      'heartbeat, held': 4,
      'heartbeat, refused': 4,
      // Unchanged by sagas: the phase is one more predicate of a statement already sent.
      'set-checkpoint of a step': 4,
      'set-checkpoint of a start marker': 4,
      'set-checkpoint of a rollback': 4,
      complete: 8,
      // One more than before sagas: the rollback pass, sent and matching nothing.
      'fail, final, nothing to roll back': 9,
      'fail, retrying, nothing to roll back': 9,
      'fail, final, entering the phase': 9,
      'fail, final, finishing the saga': 9,
      'fail-rollback, retrying': 9,
      'fail-rollback, final': 9,
    })
  })
}, 120_000)

/**
 * A batch of one statement with no lock coordinate is sent as that statement alone,
 * outside a transaction block, and every other shape keeps its transaction. The
 * schema-version read keeps one as well, for its READ COMMITTED.
 */
it('sends one query for a batch of one statement, and keeps a transaction for every other shape', async () => {
  await counted('shapes', async ({ db, admin, store, measure }) => {
    const Q = 'q'
    const spawned = await store.spawn(Q, 'job', '{}')
    const versionRead = await measure(() => admin.schemaVersion())
    const nextWake = await measure(() => store.nextWakeAtEpochMs(Q))
    const taskResult = await measure(() => store.getTaskResult(Q, spawned.taskId))
    const scanNothingDue = await measure(() => store.sweep(Q, 10))
    const [run] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('nothing to claim')
    await store.activate(Q, run.runId, run.claimToken, run.claimGen)
    const expire = await measure(() => store.expireLeaseNow(Q, run.runId, run.claimToken))
    const unprovenRead = await measure(() =>
      db.batch(
        'fixture:unproven-read',
        [{ sql: 'WITH one AS (SELECT 1 AS n) SELECT n FROM one', args: [] }],
        'read',
      ),
    )
    const lockedWrite = await measure(() =>
      db.batch(
        'fixture:locked-write',
        [{ sql: "UPDATE meta SET value = value WHERE key = 'absent'", args: [] }],
        { mode: 'write', transactionLock: { kind: 'claim', queue: Q, claimToken: 'fixture' } },
      ),
    )

    expect({
      'the schema version read': versionRead,
      'next-wake, a read of one statement': nextWake,
      'task-result, a read of one statement': taskResult,
      'the sweep scan with nothing due, a read of two statements': scanNothingDue,
      'expire-lease-now, a single write': expire,
      'a read that does not begin with SELECT': unprovenRead,
      'a single write under a lock coordinate': lockedWrite,
    }).toEqual({
      // BEGIN at READ COMMITTED, the read, and COMMIT.
      'the schema version read': 3,
      'next-wake, a read of one statement': 1,
      'task-result, a read of one statement': 1,
      // BEGIN, the two reads, and COMMIT.
      'the sweep scan with nothing due, a read of two statements': 4,
      'expire-lease-now, a single write': 1,
      'a read that does not begin with SELECT': 3,
      // BEGIN, the advisory lock, the write, and COMMIT.
      'a single write under a lock coordinate': 4,
    })
  })
}, 120_000)

it('refuses a write sent as a read, whether it begins with DELETE or is a SELECT that names INTO', async () => {
  // A read of one statement is sent alone only when it begins with SELECT and names no
  // INTO. Anything else sent as a read keeps the read-only transaction, where the server
  // refuses it.
  const db = await openPostgresTestDb({ idNamespace: 'read-guard' })
  try {
    await db.raw.batch('fixture:seed', [
      { sql: "INSERT INTO meta (key, value) VALUES ('kept', 'v')", args: [] },
    ])
    const sentAsARead = (sql: string) =>
      db.raw.batch('fixture:read-only', [{ sql, args: [] }], 'read').then(
        () => 'accepted',
        (error: unknown) =>
          /read-only transaction/.test(String(error)) ? 'refused by the server' : error,
      )
    const deleted = await sentAsARead("DELETE FROM meta WHERE key = 'kept'")
    const copied = await sentAsARead('SELECT value INTO copied FROM meta')
    const [after] = await db.raw.batch(
      'fixture:read',
      [
        {
          sql: `SELECT (SELECT COUNT(*) FROM meta WHERE key = 'kept') AS kept,
                       CASE WHEN to_regclass('copied') IS NULL THEN 0 ELSE 1 END AS copies`,
          args: [],
        },
      ],
      'read',
    )
    expect(
      { deleted, kept: after?.rows[0]?.kept },
      'mutation-verdict:behavior:postgres-lone-read-begins-with-select',
    ).toEqual({ deleted: 'refused by the server', kept: 1 })
    expect(
      { copied, copies: after?.rows[0]?.copies },
      'mutation-verdict:behavior:postgres-lone-read-names-no-into',
    ).toEqual({ copied: 'refused by the server', copies: 0 })
  } finally {
    await db.close()
  }
}, 120_000)

it('refuses a delete sent behind a select in one read, and keeps the row', async () => {
  // Text is not read, so nothing about how a statement begins says what it holds. A read
  // the executor did not get from core's read path keeps the read-only transaction, where
  // the server refuses the write whatever the text looks like.
  const db = await openPostgresTestDb({ idNamespace: 'read-guard-text' })
  try {
    await db.raw.batch('fixture:seed', [
      { sql: "INSERT INTO meta (key, value) VALUES ('kept', 'v')", args: [] },
    ])
    const outcome = await db.raw
      .batch(
        'fixture:read-only',
        [{ sql: "SELECT 1; DELETE FROM meta WHERE key = 'kept'", args: [] }],
        'read',
      )
      .then(
        () => 'accepted',
        (error: unknown) =>
          /read-only transaction/.test(String(error)) ? 'refused by the server' : String(error),
      )
    const [after] = await db.raw.batch(
      'fixture:read',
      [{ sql: "SELECT COUNT(*) AS kept FROM meta WHERE key = 'kept'", args: [] }],
      'read',
    )
    expect({ outcome, kept: after?.rows[0]?.kept }).toEqual({
      outcome: 'refused by the server',
      kept: 1,
    })
  } finally {
    await db.close()
  }
}, 120_000)

it('rolls back a single write whose result it refuses', async () => {
  // The executor reads a result only after the server has run the statement. Inside a
  // transaction a result it refuses rolls the write back, and sent alone the write would
  // already be committed.
  const db = await openPostgresTestDb({ idNamespace: 'single-write-result' })
  try {
    await db.raw.batch('fixture:seed', [
      { sql: "INSERT INTO meta (key, value) VALUES ('kept', 'before')", args: [] },
    ])
    const outcome = await db.raw
      .batch('fixture:refused-result', [
        { sql: "UPDATE meta SET value = 'after' WHERE key = 'kept' RETURNING true", args: [] },
      ])
      .then(
        () => 'accepted',
        () => 'refused',
      )
    const [after] = await db.raw.batch(
      'fixture:read',
      [{ sql: "SELECT value FROM meta WHERE key = 'kept'", args: [] }],
      'read',
    )
    expect({ outcome, value: after?.rows[0]?.value }).toEqual({
      outcome: 'refused',
      value: 'before',
    })
  } finally {
    await db.close()
  }
}, 120_000)

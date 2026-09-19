import {
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  encodeRollbackTry,
} from '@durablerun/core'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PgExecutor, PostgresSchedulerStore, PostgresStoreAdmin } from '../src/index.js'
import { postgresTestIdSource } from '../src/testing.js'

/**
 * Every query a store call sends is a round trip, with BEGIN, the event lock, and COMMIT
 * among them, and the link to PostgreSQL is the slow part of every batch. A statement
 * whose gate wrote no row is never sent (`SqlStatement.skipUnlessWrote`), so the count
 * depends on which arms of a batch fire, and it is pinned here for each arm a saga adds.
 *
 * What a saga costs a task that has none: one query on every failure. The rollback pass
 * is gated on the failure alone, so it is sent, and matches nothing. The store decides
 * whether a rollback is owed from its own rows, and a caller's hint that none is would
 * be a second account of those rows, which a worker of an older build could not give.
 */
it('sends a pinned number of queries for each batch a saga touches, and for a heartbeat', async () => {
  const url = process.env.DURABLERUN_POSTGRES_URL
  if (!url)
    throw new Error('DURABLERUN_POSTGRES_URL is required, as it is for the conformance suite')
  const schema = `durablerun_round_trips_${process.pid}`
  const control = new Pool({ connectionString: url })
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await control.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
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
    await admin.migrate()
    await admin.setFakeNowEpochMs(1_000_000)
    const store = new PostgresSchedulerStore(db, postgresTestIdSource('round-trips'))
    const Q = 'q'
    const E = '{"name":"E"}'
    const measure = async (op: () => Promise<unknown>) => {
      const before = sent
      await op()
      return sent - before
    }
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
      // refused beat skips the gated read, then reads the run's state in a batch of its own.
      'heartbeat, held': 4,
      'heartbeat, refused': 6,
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
  } finally {
    await pool.end().catch(() => undefined)
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
    await control.end().catch(() => undefined)
  }
}, 120_000)

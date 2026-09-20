import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PgExecutor } from '../src/executor.js'
import { PostgresSchedulerStore } from '../src/store.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * A read batch that PostgreSQL aborts as a deadlock victim is run again, like a write. A
 * read takes no row lock, and it can still lose a deadlock to anything that takes table
 * locks, which a schema version does: the read holds one table and waits for a second that
 * the version holds, while the version waits for the first. A read that is reported and not
 * run again is an error at a caller, an outage at a driver, and a run that waits out its
 * lease, all for a batch that had committed nothing.
 *
 * A connection stands in for a version: it takes `tasks`, the next-wake read starts, the
 * server is asked until it shows the read holding `runs` and waiting for `tasks`, and then
 * the connection asks for `runs`. That is a deadlock, and only the read's abort can give the
 * connection `runs`, which is how the case knows the deadlock happened. The read must then
 * return, and its executor must have counted one victim, as it counts a write's. If the
 * read's statement ever takes its tables in the other order, the case fails at its wait and
 * says so.
 *
 * One thing here is timed, and it is given room. PostgreSQL checks a lock wait for a deadlock
 * once, when the waiter's `deadlock_timeout` has passed, and whoever finds the deadlock is
 * its victim. So the connection's request for `runs` must reach the server before the read
 * has looked. The read's timeout is five seconds for that reason, where the server's default
 * is one, and the connection's is a minute, so the read is the one that looks first. A stall
 * that outlasts five seconds makes the connection the victim, a minute later, and the case
 * then fails saying that the read was not the victim, under a limit of ninety seconds.
 * This needs a server, and a user that may set `deadlock_timeout`, which the test servers'
 * user is.
 */
const READ_DEADLOCK_TIMEOUT_S = 5
const STAND_IN_DEADLOCK_TIMEOUT_S = 60
describe('a read batch that loses a deadlock', () => {
  it('is run again and returns', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'deadlocked-read' })
    const clients: Client[] = []
    const executors: PgExecutor[] = []
    const connect = async (options: string): Promise<Client> => {
      const client = new Client({
        connectionString: process.env.DURABLERUN_POSTGRES_URL,
        options: `-c search_path=${db.schemaName} ${options}`,
      })
      clients.push(client)
      await client.connect()
      return client
    }
    try {
      const version = await connect(`-c deadlock_timeout=${STAND_IN_DEADLOCK_TIMEOUT_S}s`)
      const watcher = await connect('')
      await version.query('BEGIN')
      await version.query('LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE')

      const executor = PgExecutor.open({
        connectionString: process.env.DURABLERUN_POSTGRES_URL,
        options: `-c search_path=${db.schemaName} -c deadlock_timeout=${READ_DEADLOCK_TIMEOUT_S}s`,
      })
      executors.push(executor)
      const store = new PostgresSchedulerStore(executor, db.ids)
      const read = store.nextWakeAtEpochMs('q').then(
        () => 'returned',
        (error: unknown) =>
          `${error instanceof Error ? error.constructor.name : 'thrown'}: ${String(
            error instanceof Error ? error.message : error,
          )}`,
      )

      // The read holds `runs` and waits for `tasks`. Bounded, and said so when it fails.
      let readIsWaiting = false
      const deadline = performance.now() + 5_000
      while (!readIsWaiting && performance.now() < deadline) {
        const seen = await watcher.query(
          `SELECT 1
             FROM pg_locks waiting
             JOIN pg_locks held ON held.pid = waiting.pid
            WHERE NOT waiting.granted AND waiting.locktype = 'relation'
              AND waiting.relation = 'tasks'::regclass
              AND held.granted AND held.locktype = 'relation'
              AND held.relation = 'runs'::regclass`,
        )
        readIsWaiting = seen.rows.length > 0
      }
      expect(readIsWaiting, 'the read never held runs while it waited for tasks').toBe(true)

      // Only the read's abort can give this connection `runs` while its transaction is open.
      // Aborted itself, it asked too late: the read had already looked for a deadlock.
      const standIn = await version.query('LOCK TABLE runs IN ACCESS EXCLUSIVE MODE').then(
        () => 'was given runs',
        (error: unknown) =>
          `was aborted: ${error instanceof Error ? error.message : String(error)}`,
      )
      expect(
        standIn,
        `the read was not the victim: the stand-in asked for runs more than ${READ_DEADLOCK_TIMEOUT_S} s after the read began to wait`,
      ).toBe('was given runs')
      await version.query('COMMIT')
      expect(await read, 'mutation-verdict:behavior:postgres-deadlocked-read-runs-again').toBe(
        'returned',
      )
      // The victim is counted as a write's is, so whoever watches the count sees this one.
      expect(executor.deadlocks).toBe(1)
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)))
      await Promise.all(executors.map((executor) => executor.close().catch(() => undefined)))
      await db.close()
    }
  }, 90_000)
})

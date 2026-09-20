import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
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
 * Nothing here is left to a race. A connection stands in for a version: it takes `tasks`,
 * the next-wake read starts, the server is asked until it shows the read holding `runs` and
 * waiting for `tasks`, and then the connection asks for `runs`. That is a deadlock, and the
 * read is the victim, because the other side's deadlock timeout is set far past the read's
 * one second. Only the read's abort can give the connection `runs`, which is how the case
 * knows the deadlock happened. The read must then return. If the read's statement ever takes
 * its tables in the other order, the case fails at its wait and says so. This needs a
 * server, and a user that may set `deadlock_timeout`, which the test servers' user is.
 */
describe('a read batch that loses a deadlock', () => {
  it('is run again and returns', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'deadlocked-read' })
    const clients: Client[] = []
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
      const version = await connect('-c deadlock_timeout=30s')
      const watcher = await connect('')
      await version.query('BEGIN')
      await version.query('LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE')

      const store = new PostgresSchedulerStore(db.raw, db.ids)
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
      await version.query('LOCK TABLE runs IN ACCESS EXCLUSIVE MODE')
      await version.query('COMMIT')
      expect(await read).toBe('returned')
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)))
      await db.close()
    }
  }, 30_000)
})

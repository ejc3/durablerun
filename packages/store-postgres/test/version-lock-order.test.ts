import type { SqlExecutor } from '@durablerun/core'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { PgExecutor } from '../src/executor.js'
import { MIGRATIONS } from '../src/schema.js'
import { PostgresSchedulerStore } from '../src/store.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * A version that locks tables takes them in the order the engine's own statements do: a
 * store table first and `meta` last, because every statement that reads the clock takes its
 * own table and then `meta`. A version waits for the transactions that were open when it
 * started. A statement that arrives meanwhile must wait holding nothing, which is what
 * leaves it nothing to deadlock with. A version that takes `meta` first gets the opposite:
 * the arrival takes its own table and queues for `meta` behind the version's request, and
 * the version then asks for that table. PostgreSQL ends that after its deadlock timeout by
 * aborting one of the two, and a build whose executor does not run a read again reports a
 * read that loses to its caller.
 *
 * Nothing here is left to a race. A connection stands in for a transaction that was open
 * when the version started: it has read the clock, so it holds `meta`. The real migrator
 * runs, and the server's lock table is asked until it shows the migrator waiting. Then a
 * sweep, whose scan is a read batch that reads the clock, and a spawn, which is a write,
 * arrive on connections of their own, and the lock table is asked until both wait. What
 * each holds on a store table while it waits is the verdict. The older transaction then
 * ends, the version commits, and both calls return. Every wait is bounded and says what it
 * waited for. This runs for every version whose first statement takes table locks, and it
 * needs a server.
 *
 * What the older transaction did, and which arrivals then wait, is each version's own
 * (`OLDER`). A version that builds indexes takes the lock a build takes, which blocks writes
 * and no read, so there the older transaction has written, the write that arrives waits,
 * and the read returns while the older transaction is still open.
 */
class StoppedBeforeTheVersion extends Error {}

const WAIT_BOUND_MS = 10_000

// Every backend that waits for a lock on a relation of the fixture's schema, by the name its
// connection gave, with the locks it holds on the schema's tables while it waits.
const WAITERS = `SELECT a.application_name AS who,
        ARRAY(SELECT c.relname || ' ' || h.mode
                FROM pg_locks h
                JOIN pg_class c ON c.oid = h.relation
               WHERE h.pid = w.pid AND h.granted AND h.locktype = 'relation'
                 AND c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace
               ORDER BY 1) AS holds
   FROM pg_locks w
   JOIN pg_class wc ON wc.oid = w.relation
   JOIN pg_stat_activity a ON a.pid = w.pid
  WHERE NOT w.granted AND w.locktype = 'relation'
    AND wc.relnamespace = current_schema()::regnamespace
  ORDER BY 1`

type Waiter = { who: string; holds: string[] }

const lockingVersions = MIGRATIONS.filter(({ statements }) =>
  /^\s*LOCK TABLE\b/.test(statements[0] ?? ''),
)

/** The calls that arrive while a version waits: a sweep, whose scan reads, and a spawn, which writes. */
const ARRIVALS = ['spawn', 'sweep'] as const
type Arrival = (typeof ARRIVALS)[number]

/**
 * For each version whose first statement takes table locks: what the transaction that was
 * open when it started had done, and which arrivals the version then makes wait.
 *
 * Version 7 takes every table in a mode that blocks reads too, `meta` last. The older
 * transaction has read the clock, so it holds `meta`, and the version waits for it holding
 * every store table. The read and the write that arrive both wait.
 *
 * Version 12 builds an index on `runs` and one on `tasks`, and takes the lock each build
 * takes, `tasks` last. The older transaction has written to `tasks`, so the version waits
 * for it holding `runs`. The write that arrives waits. The read is not blocked.
 */
const OLDER: Readonly<Record<number, { did: string; blocks: readonly Arrival[] }>> = {
  7: { did: "SELECT value FROM meta WHERE key = 'fake_now_ms'", blocks: ['spawn', 'sweep'] },
  12: { did: "UPDATE tasks SET state = state WHERE task_id = 'no such task'", blocks: ['spawn'] },
}

/** The arrivals a version does not block, each of which returns while the older transaction is open. */
const notBlockedBy = (version: number): Arrival[] =>
  ARRIVALS.filter((arrival) => !OLDER[version]?.blocks.includes(arrival))

const outcome = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'returned',
    (error: unknown) =>
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  )

describe('a statement that arrives while a version waits for an older transaction', () => {
  it('waits holding no store table, so it cannot deadlock with the version', async () => {
    // The scenario cannot pass by finding no version to run, and a version that takes table
    // locks has its older transaction written down above before it is run.
    expect(lockingVersions.map(({ version }) => version)).toEqual(Object.keys(OLDER).map(Number))
    const verdicts: {
      version: number
      arrivals: Waiter[]
      returnedMeanwhile: Record<string, string>
      ended: Record<string, string>
    }[] = []
    for (const { version } of lockingVersions) {
      const scenario = OLDER[version]
      if (scenario === undefined) throw new Error(`version ${version} has no older transaction`)
      const db = await openPostgresTestDb({
        idNamespace: `version-lock-order-${version}`,
        migrate: false,
      })
      const connection = {
        connectionString: process.env.DURABLERUN_POSTGRES_URL,
        options: `-c search_path=${db.schemaName}`,
      }
      const executors: PgExecutor[] = []
      const clients: Client[] = []
      const open = (name: string): PgExecutor => {
        const executor = PgExecutor.open({ ...connection, application_name: name })
        executors.push(executor)
        return executor
      }
      const connect = async (): Promise<Client> => {
        const client = new Client(connection)
        clients.push(client)
        await client.connect()
        return client
      }
      try {
        // The schema at the version before this one: the real migrator, stopped at this one.
        const stopping: SqlExecutor = {
          batch: async (label, statements, control) => {
            if (label === `migrate:v${version}`) throw new StoppedBeforeTheVersion()
            return db.raw.batch(label, statements, control)
          },
        }
        await expect(new PostgresStoreAdmin(stopping).migrate()).rejects.toBeInstanceOf(
          StoppedBeforeTheVersion,
        )
        const older = await connect()
        const watcher = await connect()
        const waiters = async (enough: (seen: Waiter[]) => boolean, what: string) => {
          const deadline = performance.now() + WAIT_BOUND_MS
          let seen: Waiter[] = []
          while (performance.now() < deadline) {
            seen = (await watcher.query<Waiter>(WAITERS)).rows
            if (enough(seen)) return seen
          }
          throw new Error(`${what} within ${WAIT_BOUND_MS} ms: ${JSON.stringify(seen)}`)
        }

        await older.query('BEGIN')
        await older.query(scenario.did)
        const migrating = outcome(new PostgresStoreAdmin(open('version')).migrate())
        await waiters(
          (seen) => seen.some(({ who }) => who === 'version'),
          `version ${version} did not wait for the older transaction`,
        )
        const calls: Record<Arrival, Promise<string>> = {
          sweep: outcome(new PostgresSchedulerStore(open('sweep'), db.ids).sweep('q', 10)),
          spawn: outcome(new PostgresSchedulerStore(open('spawn'), db.ids).spawn('q', 'job', '{}')),
        }
        const seen = await waiters(
          (rows) => scenario.blocks.every((name) => rows.some(({ who }) => who === name)),
          `${scenario.blocks.join(' and ')} did not wait`,
        )
        // An arrival the version does not block returns while the older transaction is open.
        // The wait for it is bounded as every other is, by asking the server again.
        const returnedMeanwhile: Record<string, string> = {}
        for (const arrival of notBlockedBy(version)) {
          let answer: string | undefined
          void calls[arrival].then((value) => {
            answer = value
          })
          const deadline = performance.now() + WAIT_BOUND_MS
          while (answer === undefined && performance.now() < deadline) await watcher.query(WAITERS)
          returnedMeanwhile[arrival] = answer ?? `still waiting after ${WAIT_BOUND_MS} ms`
        }
        await older.query('COMMIT')
        verdicts.push({
          version,
          arrivals: seen.filter(({ who }) => who !== 'version'),
          returnedMeanwhile,
          ended: {
            version: await migrating,
            sweep: await calls.sweep,
            spawn: await calls.spawn,
          },
        })
      } finally {
        await Promise.all(clients.map((client) => client.end().catch(() => undefined)))
        await Promise.all(executors.map((executor) => executor.close().catch(() => undefined)))
        await db.close()
      }
    }
    expect(
      verdicts,
      'mutation-verdict:behavior:postgres-version-locks-meta-before-the-store-tables',
    ).toEqual(
      lockingVersions.map(({ version }) => ({
        version,
        arrivals: (OLDER[version]?.blocks ?? []).map((who) => ({ who, holds: [] })),
        returnedMeanwhile: Object.fromEntries(
          notBlockedBy(version).map((arrival) => [arrival, 'returned']),
        ),
        ended: { version: 'returned', sweep: 'returned', spawn: 'returned' },
      })),
    )
  }, 120_000)
})

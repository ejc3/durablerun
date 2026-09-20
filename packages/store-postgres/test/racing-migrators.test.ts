import type { SqlBatchControl, SqlExecutor, SqlStatement } from '@durablerun/core'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { PgExecutor } from '../src/executor.js'
import { compilePostgresPlaceholders } from '../src/placeholders.js'
import { MIGRATIONS } from '../src/schema.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * A deploy starts several workers together, some of the released build and some of this
 * one, and each calls `migrate()`. The second migrator of a version must wait for the first
 * and then find the version applied, whichever build each is of. It must never deadlock
 * with it: PostgreSQL takes its deadlock timeout, a second, to abort one of the two, and
 * the executor then runs the victim again where nobody sees it.
 *
 * This is the rolling deploy case for PostgreSQL. The released build took the lock on
 * `meta` as the first statement of each version's batch. This build's batch names the lock
 * in its control, and its executor takes it. One migrator here is the released build's,
 * sent by hand over a connection of its own: BEGIN, the lock statement as that build sent
 * it, which is spelled below and must NOT follow the source, and then the version's
 * statements as the admin builds them. The other is this build's: the batch and the control
 * the real admin builds, sent through the real executor.
 *
 * Nothing is left to a race. The first migrator is stopped once it has written its sentinel
 * row: by hand where it is sent by hand, and on an advisory lock the test holds where it
 * goes through the executor. The server's lock table is asked until it shows the second
 * waiting, and only then does the first go on and commit. That holds for every version,
 * each over a schema at the version before it, and in both orders. This needs a server.
 *
 * What each side must reach: the first commits. The second waits for the lock on `meta`,
 * and while it waits it holds no lock on any relation of the schema, which is what leaves
 * the first nothing to deadlock with. A second migrator that instead waits for the first
 * one's transaction, on the uncommitted sentinel row, holds a lock on `meta` while it does,
 * and the case reports that at every version, and not only at the version that goes on to
 * lock `meta` itself. The second then loses to the first one's committed sentinel with
 * unique_violation (23505), and the version it reads next is already the one it tried to
 * write, which is what lets `migrate()` call its write complete. A deadlock (40P01) on
 * either side fails the case, and so does one the executor ran again and hid.
 *
 * Every wait is bounded for each version, and a migrator that never blocked fails the case
 * and says so. The test's own limit is set past the sum of those bounds, so the bound is
 * what reports, and never the limit.
 */
class StoppedBeforeTheVersion extends Error {}

const WAIT_BOUND_MS = 5_000

// What the released build sent as the first statement of every version's batch.
const RELEASED_BUILD_LOCK = 'LOCK TABLE meta IN SHARE ROW EXCLUSIVE MODE'

// What one backend waits for, and the locks it holds on relations of the fixture's schema.
const LOCKS_OF = `SELECT l.granted, l.locktype, l.mode, c.relname
   FROM pg_locks l
   LEFT JOIN pg_class c ON l.locktype = 'relation' AND c.oid = l.relation
  WHERE l.pid = $1
    AND (NOT l.granted
         OR (l.locktype = 'relation' AND c.relnamespace = current_schema()::regnamespace))`

/** The SQLSTATE of a failure, through whatever the executor wrapped it in. */
function sqlState(error: unknown): string {
  for (let at: unknown = error; typeof at === 'object' && at !== null; ) {
    if ('code' in at && typeof at.code === 'string') return at.code
    at = 'cause' in at ? at.cause : undefined
  }
  return String(error)
}

async function send(client: Client, statements: readonly SqlStatement[]): Promise<void> {
  for (const statement of statements) {
    await client.query(compilePostgresPlaceholders(statement.sql).sql, [...statement.args])
  }
}

type Order = 'the released build first' | 'this build first'

/** One version raced at every version, in one order: what each migrator reached. */
async function raceAtEveryVersion(order: Order): Promise<Record<string, unknown>[]> {
  const connectionString = process.env.DURABLERUN_POSTGRES_URL
  const outcomes: Record<string, unknown>[] = []
  for (const { version } of MIGRATIONS) {
    const db = await openPostgresTestDb({
      idNamespace: `racing-migrators-${version}-${order === 'this build first' ? 'this' : 'released'}`,
      migrate: false,
    })
    const options = `-c search_path=${db.schemaName}`
    const clients: Client[] = []
    const connect = async (): Promise<Client> => {
      const client = new Client({ connectionString, options })
      clients.push(client)
      await client.connect()
      return client
    }
    // This build's migrator has one connection, so that the backend the server is
    // asked about is the one its batch will run on.
    const thisBuild = PgExecutor.open({ connectionString, options, max: 1 })
    try {
      const [byHand, watcher] = await Promise.all([connect(), connect()])
      const [backend] = await thisBuild.batch(
        'fixture:backend',
        [{ sql: 'SELECT pg_backend_pid() AS pid', args: [] }],
        'read',
      )
      const thisBuildPid = Number(backend?.rows[0]?.pid)
      const byHandPid = Number(
        (await byHand.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
      )

      // The schema at the version before this one, and this version's batch with its
      // control as the admin builds them: the real migrator runs, and is stopped where
      // it would send the batch.
      const batch: SqlStatement[] = []
      let control: SqlBatchControl | undefined
      const stopping: SqlExecutor = {
        batch: async (label, statements, sent) => {
          if (label !== `migrate:v${version}`) return db.raw.batch(label, statements, sent)
          batch.push(...statements)
          control = sent
          throw new StoppedBeforeTheVersion()
        },
      }
      await expect(new PostgresStoreAdmin(stopping).migrate()).rejects.toBeInstanceOf(
        StoppedBeforeTheVersion,
      )
      const sentinelAt = batch.findIndex(({ sql }) => sql.includes(`'applied:v${version}'`))
      expect(sentinelAt, `version ${version} writes its sentinel`).toBeGreaterThanOrEqual(0)
      const releasedBuildBatch = [{ sql: RELEASED_BUILD_LOCK, args: [] }, ...batch]

      const blocks = async (pid: number, settled: () => boolean) => {
        const deadline = performance.now() + WAIT_BOUND_MS
        while (!settled() && performance.now() < deadline) {
          const seen = await watcher.query<{
            granted: boolean
            locktype: string
            mode: string
            relname: string | null
          }>(LOCKS_OF, [pid])
          const waiting = seen.rows.find((row) => !row.granted)
          if (waiting === undefined) continue
          return {
            waitsFor: [waiting.locktype, waiting.relname, waiting.mode]
              .filter((part) => part !== null)
              .join(' '),
            holds: seen.rows
              .filter((row) => row.granted)
              .map((row) => `${row.relname} ${row.mode}`)
              .sort(),
          }
        }
        return { waitsFor: 'nothing: it never blocked', holds: [] }
      }

      let first: Promise<string>
      let second: Promise<string>
      let secondBlocked: Awaited<ReturnType<typeof blocks>>
      let secondSettled = false
      if (order === 'the released build first') {
        await byHand.query('BEGIN')
        await send(byHand, releasedBuildBatch.slice(0, sentinelAt + 2))
        second = thisBuild
          .batch(`migrate:v${version}`, batch, control)
          .then(() => 'committed', sqlState)
          .finally(() => {
            secondSettled = true
          })
        secondBlocked = await blocks(thisBuildPid, () => secondSettled)
        first = send(byHand, releasedBuildBatch.slice(sentinelAt + 2))
          .then(() => byHand.query('COMMIT'))
          .then(() => 'committed', sqlState)
      } else {
        // This build's migrator stops after its sentinel on a lock the test holds.
        await watcher.query('SELECT pg_advisory_lock(hashtext($1), $2)', [db.schemaName, version])
        let firstSettled = false
        first = thisBuild
          .batch(
            `migrate:v${version}`,
            [
              ...batch.slice(0, sentinelAt + 1),
              {
                sql: `SELECT pg_advisory_xact_lock(hashtext(current_schema()), ${version})`,
                args: [],
              },
              ...batch.slice(sentinelAt + 1),
            ],
            control,
          )
          .then(() => 'committed', sqlState)
          .finally(() => {
            firstSettled = true
          })
        const stopped = await blocks(thisBuildPid, () => firstSettled)
        expect(stopped.waitsFor, 'this build stops after its sentinel').toMatch(/^advisory/)
        await byHand.query('BEGIN')
        second = send(byHand, releasedBuildBatch)
          .then(() => byHand.query('COMMIT'))
          .then(() => 'committed', sqlState)
          .finally(() => {
            secondSettled = true
          })
        secondBlocked = await blocks(byHandPid, () => secondSettled)
        await watcher.query('SELECT pg_advisory_unlock(hashtext($1), $2)', [db.schemaName, version])
      }
      const firstEnded = await first
      const secondEnded = await second
      const recorded = await watcher.query<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      )
      outcomes.push({
        version,
        order,
        first: firstEnded,
        second: secondEnded,
        secondWaitsFor: secondBlocked.waitsFor,
        secondHolds: secondBlocked.holds,
        versionTheSecondFinds: recorded.rows[0]?.value,
        deadlocksThisBuildRanAgain: thisBuild.deadlocks,
      })
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)))
      await thisBuild.close().catch(() => undefined)
      await db.close()
    }
  }
  return outcomes
}

// The second migrator waited for meta's lock holding nothing, and then lost to the first one's
// committed sentinel (23505, unique_violation). 40P01 in either column is a deadlock.
const everyVersionWaited = (order: Order) =>
  MIGRATIONS.map(({ version }) => ({
    version,
    order,
    first: 'committed',
    second: '23505',
    secondWaitsFor: 'relation meta ShareRowExclusiveLock',
    secondHolds: [],
    versionTheSecondFinds: String(version),
    deadlocksThisBuildRanAgain: 0,
  }))

const LIMIT_MS = MIGRATIONS.length * (2 * WAIT_BOUND_MS + 10_000)

describe('racing PostgreSQL migrators', () => {
  // This build's migrator arrives second, behind one of the released build. It is the order
  // that shows this build taking the lock: without it, this build's sentinel insert is what
  // waits, for another lock and, at a version that locks meta, into a deadlock.
  it(
    'make the second wait for the first at every version, and never deadlock',
    async () => {
      expect(
        await raceAtEveryVersion('the released build first'),
        'mutation-verdict:behavior:postgres-migrator-locks-meta-before-its-sentinel',
      ).toEqual(everyVersionWaited('the released build first'))
    },
    LIMIT_MS,
  )

  it(
    'make a migrator of the released build wait for this build in a rolling deploy, at every version',
    async () => {
      expect(await raceAtEveryVersion('this build first')).toEqual(
        everyVersionWaited('this build first'),
      )
    },
    LIMIT_MS,
  )
})

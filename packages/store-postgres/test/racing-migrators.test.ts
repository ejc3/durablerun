import { randomUUID } from 'node:crypto'
import type { SqlBatchControl, SqlExecutor, SqlStatement } from '@durablerun/core'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { PgExecutor } from '../src/executor.js'
import { compilePostgresPlaceholders } from '../src/placeholders.js'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/schema.js'
import { PostgresSchedulerStore } from '../src/store.js'
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

/**
 * Version 9 builds `runs_held`, an index of the claim token over the running runs, and a
 * btree row on PostgreSQL may not pass about 2,700 bytes. `claim` holds a token to an
 * identifier's width since that version, so no row a current build writes is too long for
 * it. A database that an OLDER build left, with a run still running under a caller's
 * token of any length, can hold one. There the version fails, loudly and whole, and the
 * database stays at version 8, which every build runs against. It heals by itself, a
 * little later than when the run ends: an index build also indexes a row version that is
 * dead but that an open snapshot can still see, and it judges the index's predicate on
 * that old version. Two kinds of transaction hold such a snapshot. One has a snapshot in
 * this database. The other has a transaction id of its own in ANY database of the server,
 * because the building session's own snapshot reaches back to the oldest transaction id
 * still running on the server. So the same `migrate()` succeeds once that run has ended,
 * or the sweep has taken its lease, AND no transaction that was open at that moment still
 * holds either. Measured with one transaction held open on purpose: a write transaction in
 * another database refused the version, and a read-only snapshot in another database did
 * not.
 *
 * The test holds the sentence both ways. It runs in a database of its own, which it
 * creates and drops, so the only snapshot in its database is the one it opens on purpose,
 * and the version is refused while that one is open. Other tests share the server, and
 * their write transactions count, so before it asks for the version again it waits for
 * the exact condition: the server's oldest running transaction id has passed one taken
 * after the run ended. It then asks once, and the version builds. This needs a server, and
 * a role that may create a database.
 */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('version 9 over a run held under a token too long for its index', () => {
  it('fails loudly and leaves version 8 while the run runs, and while an open snapshot still sees it, and then succeeds', async () => {
    const shared = process.env.DURABLERUN_POSTGRES_URL
    if (!shared) throw new Error('this test requires DURABLERUN_POSTGRES_URL')
    const own = `durablerun_own_${randomUUID().replaceAll('-', '')}`
    const ownUrl = new URL(shared)
    ownUrl.pathname = `/${own}`
    const control = new Client({ connectionString: shared })
    await control.connect()
    // `own` is this file's literal and 32 hex digits, so no other text reaches this DDL.
    await control.query(`CREATE DATABASE ${own} TEMPLATE template0`)
    const sessions: Client[] = []
    let db: Awaited<ReturnType<typeof openPostgresTestDb>> | undefined
    try {
      db = await openPostgresTestDb({
        connectionString: ownUrl.toString(),
        idNamespace: 'long-token-before-version-9',
      })
      const session = async () => {
        const client = new Client({ connectionString: ownUrl.toString() })
        await client.connect()
        sessions.push(client)
        await client.query(`SET search_path TO "${db?.schemaName}"`)
        return client
      }
      const client = await session()
      const other = await session()
      const admin = db.admin
      const store = new PostgresSchedulerStore(db.raw, db.ids)
      await store.spawn('q', 'job', '{}')
      const [run] = await store.claim('q', 'a-short-token', { leaseSeconds: 60, limit: 1 })
      if (run === undefined) throw new Error('the job was not claimed')
      await store.activate('q', run.runId, run.claimToken, run.claimGen)
      // What an older build left: no index, version 8, and the run held under 3,000
      // characters that no compression shortens.
      let x = 0x2545f491
      const token = Array.from({ length: 3000 }, () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0
        return (x >>> 28).toString(16)
      }).join('')
      await client.query('DROP INDEX runs_held')
      await client.query(`DELETE FROM meta WHERE key = 'applied:v${CURRENT_SCHEMA_VERSION}'`)
      await client.query(`UPDATE meta SET value = $1 WHERE key = 'schema_version'`, [
        String(CURRENT_SCHEMA_VERSION - 1),
      ])
      await client.query('UPDATE runs SET claimed_by = $1 WHERE run_id = $2', [token, run.runId])
      expect(CURRENT_SCHEMA_VERSION).toBe(9)
      const migrated = async () => ({
        answer: await admin.migrate().then(
          () => 'migrated',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        version: await admin.schemaVersion(),
      })
      const refused = { answer: expect.stringMatching(/54000/), version: 8 }

      // The run still runs under its long token.
      expect(await migrated()).toEqual(refused)

      // Another session takes its snapshot while the run still runs, and keeps it open.
      await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await other.query('SELECT count(*) FROM runs')
      // The run ends under its own token, as the older build that holds it would end it.
      // This build's port refuses a token past the width at every entry, so the entry is
      // called from the prototype, which is the entry with nothing in front of it, as an
      // older build's was.
      await PostgresSchedulerStore.prototype.complete.call(store, 'q', run.runId, token, '{}')
      // A transaction id taken now is newer than the one that ended the run.
      const ended = await client.query('SELECT pg_current_xact_id()::text AS id')
      // The run's old version is dead, that snapshot can still see it, and the build meets it.
      expect(await migrated()).toEqual(refused)

      // The snapshot is closed, and nothing else in this database holds one. A transaction
      // of another test, in another database, may still hold a transaction id from before
      // the run ended. The longest any PostgreSQL test of this repository holds one open is
      // bounded at 5 s (a racing migrator waiting to be seen), so 60 s is twelve times that.
      await other.query('COMMIT')
      for (let tries = 0; ; tries++) {
        const oldest = await client.query(
          'SELECT pg_snapshot_xmin(pg_current_snapshot()) > $1::xid8 AS passed',
          [(ended.rows[0] as { id: string }).id],
        )
        if ((oldest.rows[0] as { passed: boolean }).passed) break
        if (tries >= 1200) throw new Error('a transaction from before the run ended is still open')
        await pause(50)
      }
      // Asked once, not until it works: nothing that was open when the run ended is open.
      expect(await migrated()).toEqual({ answer: 'migrated', version: 9 })
      const built = await client.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'runs_held'`,
        [db.schemaName],
      )
      expect(built.rowCount).toBe(1)
    } finally {
      for (const client of sessions) await client.end().catch(() => undefined)
      if (db !== undefined) await db.close().catch(() => undefined)
      await control.query(`DROP DATABASE IF EXISTS ${own} WITH (FORCE)`)
      await control.end()
    }
  }, 90_000) // Past the 60 s the wait above may take, so that bound is what reports.
})

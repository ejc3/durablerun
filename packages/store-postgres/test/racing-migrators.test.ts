import { randomUUID } from 'node:crypto'
import type { SqlExecutor, SqlStatement } from '@durablerun/core'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { compilePostgresPlaceholders } from '../src/placeholders.js'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/schema.js'
import { PostgresSchedulerStore } from '../src/store.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * Several workers of a new deploy start together, and each calls `migrate()`. The second
 * migrator of a version must wait for the first and then find the version applied. It must
 * never deadlock with it: PostgreSQL takes its deadlock timeout, a second, to abort one of
 * the two, and the executor then runs the victim again where nobody sees it.
 *
 * Nothing here is left to a race. Two connections replay one version's batch exactly as the
 * admin builds it, by hand: the second starts at the moment the first has written its
 * sentinel row, the server's lock table is asked until it shows the second waiting, and
 * only then does the first go on and commit. That holds for every version, each over a
 * schema at the version before it. This needs a server.
 *
 * What each side must reach: the first commits. The second waits for the lock on `meta`
 * that every version's batch takes first, and while it waits it holds no lock on any
 * relation of the schema, which is what leaves the first nothing to deadlock with. A second
 * migrator that instead waits for the first one's transaction, on the uncommitted sentinel
 * row, holds a lock on `meta` while it does, and the case reports that at every version,
 * and not only at the version that goes on to lock `meta` itself. The second then loses to
 * the first one's committed sentinel with unique_violation (23505), and the version it
 * reads next is already the one it tried to write, which is what lets `migrate()` call its
 * write complete. A deadlock (40P01) on either side fails the case.
 *
 * The wait for the second to block is bounded for each version, and a second migrator that
 * never blocked fails the case and says so. The test's own limit is set past the sum of
 * those bounds, so the bound is what reports, and never the limit.
 */
class StoppedBeforeTheVersion extends Error {}

const WAIT_BOUND_MS = 5_000

// What one backend waits for, and the locks it holds on relations of the fixture's schema.
const LOCKS_OF = `SELECT l.granted, l.locktype, l.mode, c.relname
   FROM pg_locks l
   LEFT JOIN pg_class c ON l.locktype = 'relation' AND c.oid = l.relation
  WHERE l.pid = $1
    AND (NOT l.granted
         OR (l.locktype = 'relation' AND c.relnamespace = current_schema()::regnamespace))`

const sqlState = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : String(error)

async function send(client: Client, statements: readonly SqlStatement[]): Promise<void> {
  for (const statement of statements) {
    await client.query(compilePostgresPlaceholders(statement.sql).sql, [...statement.args])
  }
}

describe('racing PostgreSQL migrators', () => {
  it(
    'make the second wait for the first at every version, and never deadlock',
    async () => {
      const outcomes: {
        version: number
        first: string
        second: string
        secondWaitsFor: string
        secondHolds: string[]
        versionTheSecondFinds: string | undefined
      }[] = []
      for (const { version } of MIGRATIONS) {
        const db = await openPostgresTestDb({
          idNamespace: `racing-migrators-${version}`,
          migrate: false,
        })
        const clients: Client[] = []
        const connect = async (): Promise<Client> => {
          const client = new Client({
            connectionString: process.env.DURABLERUN_POSTGRES_URL,
            options: `-c search_path=${db.schemaName}`,
          })
          clients.push(client)
          await client.connect()
          return client
        }
        try {
          const [first, second, watcher] = await Promise.all([connect(), connect(), connect()])
          // The schema at the version before this one, and this version's batch as the admin
          // builds it: the real migrator runs, and is stopped where it would send the batch.
          const batch: SqlStatement[] = []
          const stopping: SqlExecutor = {
            batch: async (label, statements, control) => {
              if (label !== `migrate:v${version}`) return db.raw.batch(label, statements, control)
              batch.push(...statements)
              throw new StoppedBeforeTheVersion()
            },
          }
          await expect(new PostgresStoreAdmin(stopping).migrate()).rejects.toBeInstanceOf(
            StoppedBeforeTheVersion,
          )
          const sentinelAt = batch.findIndex(({ sql }) => sql.includes(`'applied:v${version}'`))
          expect(sentinelAt, `version ${version} writes its sentinel`).toBeGreaterThanOrEqual(0)

          await first.query('BEGIN')
          await send(first, batch.slice(0, sentinelAt + 1))
          const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
            .rows[0]?.pid
          await second.query('BEGIN')
          let secondSettled = false
          const secondOutcome = send(second, batch)
            .then(() => second.query('COMMIT'))
            .then(() => 'committed', sqlState)
            .finally(() => {
              secondSettled = true
            })
          let secondWaitsFor = 'nothing: it never blocked'
          let secondHolds: string[] = []
          const deadline = performance.now() + WAIT_BOUND_MS
          while (!secondSettled && performance.now() < deadline) {
            const seen = await watcher.query<{
              granted: boolean
              locktype: string
              mode: string
              relname: string | null
            }>(LOCKS_OF, [pid])
            const waiting = seen.rows.find((row) => !row.granted)
            if (waiting === undefined) continue
            secondWaitsFor = [waiting.locktype, waiting.relname, waiting.mode]
              .filter((part) => part !== null)
              .join(' ')
            secondHolds = seen.rows
              .filter((row) => row.granted)
              .map((row) => `${row.relname} ${row.mode}`)
              .sort()
            break
          }
          const firstOutcome = await send(first, batch.slice(sentinelAt + 1))
            .then(() => first.query('COMMIT'))
            .then(() => 'committed', sqlState)
          const secondEnded = await secondOutcome
          const recorded = await watcher.query<{ value: string }>(
            "SELECT value FROM meta WHERE key = 'schema_version'",
          )
          outcomes.push({
            version,
            first: firstOutcome,
            second: secondEnded,
            secondWaitsFor,
            secondHolds,
            versionTheSecondFinds: recorded.rows[0]?.value,
          })
        } finally {
          await Promise.all(clients.map((client) => client.end().catch(() => undefined)))
          await db.close()
        }
      }
      // The second migrator waited for meta's lock holding nothing, and then lost to the first
      // one's committed sentinel (23505, unique_violation). 40P01 in either column is a deadlock.
      expect(
        outcomes,
        'mutation-verdict:behavior:postgres-migrator-locks-meta-before-its-sentinel',
      ).toEqual(
        MIGRATIONS.map(({ version }) => ({
          version,
          first: 'committed',
          second: '23505',
          secondWaitsFor: 'relation meta ShareRowExclusiveLock',
          secondHolds: [],
          versionTheSecondFinds: String(version),
        })),
      )
    },
    MIGRATIONS.length * (WAIT_BOUND_MS + 10_000),
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
 * that old version. So the same `migrate()` succeeds once that run has ended, or the sweep
 * has taken its lease, AND every transaction that was open in the database at that moment
 * has finished.
 *
 * Which snapshots count is decided for each database, and every other test of this suite
 * shares one database by schema, so beside them this test once met a transaction that was
 * none of its own. It runs in a database of its own, which it creates and drops, where no
 * snapshot exists but the one it opens on purpose. That holds the sentence both ways: the
 * version is refused while that snapshot is open, and built once it is closed. This needs a
 * server, and a role that may create a database.
 */
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
      // The run ends under its own token. No entry but `claim` holds a token to the width.
      await store.complete('q', run.runId, token, '{}')
      // Its old version is dead, that snapshot can still see it, and the build meets it.
      expect(await migrated()).toEqual(refused)

      // The snapshot is closed, and nothing else in this database can hold one.
      await other.query('COMMIT')
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
  })
})

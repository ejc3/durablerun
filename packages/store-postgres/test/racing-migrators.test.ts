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
 * database stays at version 8, which every build runs against. It heals by itself: once
 * that run ends, or the sweep takes its expired lease, the same `migrate()` succeeds.
 * This needs a server.
 */
describe('version 9 over a run held under a token too long for its index', () => {
  it('fails loudly and leaves version 8, and succeeds once that run has ended', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'long-token-before-version-9' })
    const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
    await client.connect()
    try {
      await client.query(`SET search_path TO "${db.schemaName}"`)
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
      expect(await db.admin.schemaVersion()).toBe(8)

      const refusal = await db.admin.migrate().then(
        () => 'migrated',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(refusal).toMatch(/54000/)
      expect(await db.admin.schemaVersion()).toBe(8)

      // The run ends under its own token. No entry but `claim` holds a token to the width.
      await store.complete('q', run.runId, token, '{}')
      await db.admin.migrate()
      expect(await db.admin.schemaVersion()).toBe(9)
      const built = await client.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'runs_held'`,
        [db.schemaName],
      )
      expect(built.rowCount).toBe(1)
    } finally {
      await client.end()
      await db.close()
    }
  })
})

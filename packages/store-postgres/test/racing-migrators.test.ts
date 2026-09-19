import type { SqlExecutor, SqlStatement } from '@durablerun/core'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { compilePostgresPlaceholders } from '../src/placeholders.js'
import { MIGRATIONS } from '../src/schema.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * Several workers of a new deploy start together, and each calls `migrate()`. The second
 * migrator of a version must wait for the first and then find the version applied. It must
 * never deadlock with it: PostgreSQL takes its deadlock timeout, a second, to abort one of
 * the two, and the executor then runs the victim again where nobody sees it.
 *
 * Nothing here is left to a race. Two connections replay one version's batch exactly as the
 * admin builds it, by hand: the second starts at the moment the first has written its
 * sentinel row, the server is asked until it shows the second waiting on a lock, and only
 * then does the first go on and commit. That holds for every version, each over a schema at
 * the version before it. This needs a server.
 *
 * What each side must reach: the first commits. The second waits, then loses to the first
 * one's committed sentinel with unique_violation (23505), and the version it reads next is
 * already the one it tried to write, which is what lets `migrate()` call its write complete.
 * A deadlock (40P01) on either side fails the case. The wait for "blocked on a lock" is
 * bounded at ten seconds, and a second migrator that never blocked fails the case too.
 */
class StoppedBeforeTheVersion extends Error {}

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
  it('make the second wait for the first at every version, and never deadlock', async () => {
    const outcomes: {
      version: number
      first: string
      second: string
      secondWaited: boolean
      versionTheSecondFinds: string | undefined
    }[] = []
    for (const { version } of MIGRATIONS) {
      const db = await openPostgresTestDb({
        idNamespace: `racing-migrators-${version}`,
        migrate: false,
      })
      const connect = async (): Promise<Client> => {
        const client = new Client({
          connectionString: process.env.DURABLERUN_POSTGRES_URL,
          options: `-c search_path=${db.schemaName}`,
        })
        await client.connect()
        return client
      }
      const [first, second, watcher] = await Promise.all([connect(), connect(), connect()])
      try {
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
        const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid
        await second.query('BEGIN')
        let secondSettled = false
        const secondOutcome = send(second, batch)
          .then(() => second.query('COMMIT'))
          .then(() => 'committed', sqlState)
          .finally(() => {
            secondSettled = true
          })
        let secondWaited = false
        const deadline = performance.now() + 10_000
        while (!secondWaited && !secondSettled && performance.now() < deadline) {
          const seen = await watcher.query<{ wait_event_type: string | null }>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [pid],
          )
          secondWaited = seen.rows[0]?.wait_event_type === 'Lock'
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
          secondWaited,
          versionTheSecondFinds: recorded.rows[0]?.value,
        })
      } finally {
        await Promise.all([first.end(), second.end(), watcher.end()])
        await db.close()
      }
    }
    // The second migrator waited, and then lost to the first one's committed sentinel
    // (23505, unique_violation). 40P01 in either column is a deadlock.
    expect(
      outcomes,
      'mutation-verdict:behavior:postgres-migrator-locks-meta-before-its-sentinel',
    ).toEqual(
      MIGRATIONS.map(({ version }) => ({
        version,
        first: 'committed',
        second: '23505',
        secondWaited: true,
        versionTheSecondFinds: String(version),
      })),
    )
  })
})

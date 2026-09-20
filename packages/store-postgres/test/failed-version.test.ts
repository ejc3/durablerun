import type { SqlExecutor } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/schema.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * A version is one batch, and the executor runs a batch as one transaction. PostgreSQL's DDL
 * is transactional, so the sentinel, the version's statements and the version itself commit
 * together or not at all, and a version that failed leaves nothing for the next `migrate()`
 * to finish or to trip over. MySQL has no such transaction, and its store holds the other
 * half of this promise: every statement is safe to repeat. This needs a server.
 */
type TestDb = Awaited<ReturnType<typeof openPostgresTestDb>>

/** Every column, index and constraint of the fixture's schema, and what `meta` holds. */
async function holdings(db: TestDb): Promise<string> {
  const results = await db.raw.batch(
    'fixture:holdings',
    [
      `SELECT table_name, column_name, ordinal_position, data_type, collation_name,
              is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
        ORDER BY table_name, ordinal_position`,
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = current_schema()
        ORDER BY tablename, indexname`,
      `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE connamespace = current_schema()::regnamespace
        ORDER BY 1, 2`,
      'SELECT key, value FROM meta ORDER BY key',
    ].map((sql) => ({ sql, args: [] })),
    'read',
  )
  return JSON.stringify(results.map(({ rows }) => rows))
}

describe('a PostgreSQL version that failed', () => {
  it('leaves nothing behind, at every version, and the next migrate() applies it', async () => {
    // Each version in turn is made to fail after every one of its statements has run. The
    // statement that fails it writes the version's own sentinel a second time, which the
    // primary key refuses only once the first is there, so the batch was not refused
    // before it ran. What the schema holds afterwards must be what it held before.
    const outcomes: Record<string, unknown>[] = []
    for (const { version } of MIGRATIONS) {
      const db = await openPostgresTestDb({
        idNamespace: `failed-version-${version}`,
        migrate: false,
      })
      try {
        let before = 'the version was never sent'
        const failing: SqlExecutor = {
          batch: async (label, statements, control) => {
            if (label !== `migrate:v${version}`) return db.raw.batch(label, statements, control)
            before = await holdings(db)
            return db.raw.batch(
              label,
              [
                ...statements,
                {
                  sql: `INSERT INTO meta (key, value) VALUES ('applied:v${version}', 'again')`,
                  args: [],
                },
              ],
              control,
            )
          },
        }
        const migrate = await new PostgresStoreAdmin(failing).migrate().then(
          () => 'resolved',
          () => 'rejected',
        )
        const after = await holdings(db)
        const recorded = await db.admin.schemaVersion()
        await db.admin.migrate()
        outcomes.push({
          version,
          migrate,
          recorded,
          leftBehind: after === before ? 'nothing' : 'something',
          theNextMigrateReaches: await db.admin.schemaVersion(),
        })
      } finally {
        await db.close()
      }
    }
    expect(outcomes).toEqual(
      MIGRATIONS.map(({ version }) => ({
        version,
        migrate: 'rejected',
        recorded: version - 1,
        leftBehind: 'nothing',
        theNextMigrateReaches: CURRENT_SCHEMA_VERSION,
      })),
    )
  }, 120_000)
})

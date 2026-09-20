import { createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, META_BOOTSTRAP_SQL, MIGRATIONS } from '../src/schema.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * What `migrate()` owes a MySQL database that another migrator left, or still holds. These
 * cases need a MySQL server, and the root vitest configuration leaves this file out of a
 * run that was not given one. The cases themselves are never conditional.
 */

type TestDb = Awaited<ReturnType<typeof openMysqlTestDb>>

/** Every table, column, index and check of the fixture's database, and what `meta` holds. */
async function schemaOf(db: TestDb): Promise<string> {
  const results = await db.raw.batch(
    'fixture:schema',
    [
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS position,
              COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, COLLATION_NAME AS collation,
              COLUMN_DEFAULT AS column_default
         FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, SEQ_IN_INDEX AS position,
              COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, SUB_PART AS prefix
         FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      `SELECT CONSTRAINT_NAME AS constraint_name, CHECK_CLAUSE AS clause
         FROM information_schema.check_constraints
        WHERE CONSTRAINT_SCHEMA = DATABASE()
        ORDER BY CONSTRAINT_NAME`,
      'SELECT `key`, value FROM meta ORDER BY `key`',
    ].map((sql) => ({ sql, args: [] })),
    'read',
  )
  return JSON.stringify(
    results.map(({ rows }) => rows),
    (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
    1,
  )
}

describe('a MySQL version that was left half applied', () => {
  it('is finished by the next migrate(), wherever in the version the migrator died', async () => {
    // MySQL commits each DDL statement on its own. A migrator that dies inside a version
    // leaves the statements it ran, and the version it did not reach to record. No
    // transaction undoes them, so the next `migrate()` has to finish the version over
    // them. Every version that has statements is cut here after each of its statements:
    // the state is built by hand, the versions before it whole and recorded, then the
    // first statements of the version with its record not written.
    const clean = await openMysqlTestDb({ idNamespace: 'half-applied-clean' })
    const cleanSchema = await schemaOf(clean).finally(() => clean.close())

    const outcomes: {
      version: number
      statementsRun: number
      recordedBefore: number
      migrate: string
      recordedAfter: number
      schema: string
    }[] = []
    for (const [index, migration] of MIGRATIONS.entries()) {
      for (let ran = 1; ran <= migration.statements.length; ran += 1) {
        const db = await openMysqlTestDb({
          idNamespace: `half-applied-${migration.version}-${ran}`,
          migrate: false,
        })
        try {
          await db.raw.batch('fixture:half-applied', [
            { sql: META_BOOTSTRAP_SQL, args: [] },
            ...MIGRATIONS.slice(0, index)
              .flatMap((earlier) => earlier.statements)
              .map((sql) => ({ sql, args: [] })),
            {
              sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version'",
              args: [String(migration.version - 1)],
            },
            ...migration.statements.slice(0, ran).map((sql) => ({ sql, args: [] })),
          ])
          const recordedBefore = await db.admin.schemaVersion()
          const migrate = await db.admin.migrate().then(
            () => 'finished',
            (error: unknown) => String(error),
          )
          outcomes.push({
            version: migration.version,
            statementsRun: ran,
            recordedBefore,
            migrate,
            recordedAfter: await db.admin.schemaVersion(),
            schema:
              (await schemaOf(db)) === cleanSchema
                ? 'what a clean migration leaves'
                : 'differs from a clean migration',
          })
        } finally {
          await db.close()
        }
      }
    }

    expect(outcomes.length).toBeGreaterThan(1)
    expect(outcomes).toEqual(
      MIGRATIONS.flatMap((migration) =>
        migration.statements.map((_, at) => ({
          version: migration.version,
          statementsRun: at + 1,
          recordedBefore: migration.version - 1,
          migrate: 'finished',
          recordedAfter: CURRENT_SCHEMA_VERSION,
          schema: 'what a clean migration leaves',
        })),
      ),
    )
  }, 120_000)
})

describe('a MySQL migrator beside one of the released build', () => {
  it('waits for the migration lock as that build takes it, and migrates once it is free', async () => {
    // A deploy runs the build before this one beside this one, and every process of both
    // calls `migrate()`. They take turns only if both take one lock. The statement and the
    // three coordinates below are what the released build sends, spelled here and not
    // imported, so that a change to the name this build takes fails this case.
    const RELEASED_LOCK_NAME = "SHA2(JSON_ARRAY(DATABASE(), 'durablerun:migrate', '', ''), 256)"
    const db = await openMysqlTestDb({ idNamespace: 'released-build-lock', migrate: false })
    const url = process.env.DURABLERUN_MYSQL_URL
    if (!url) throw new Error('this case needs DURABLERUN_MYSQL_URL')
    const released = await createConnection({ uri: url, database: db.databaseName })
    try {
      const [taken] = await released.query(`SELECT GET_LOCK(${RELEASED_LOCK_NAME}, 0) AS acquired`)
      expect((taken as { acquired: unknown }[])[0]?.acquired).toBe(1)

      let settled = 'still waiting'
      const migrating = db.admin.migrate().then(
        () => {
          settled = 'migrated'
        },
        (error: unknown) => {
          settled = String(error)
        },
      )
      // The server's own lock table says when a session waits for that very name.
      let waiting = 0
      const deadline = performance.now() + 10_000
      while (waiting === 0 && settled === 'still waiting' && performance.now() < deadline) {
        const [pending] = await released.query(
          `SELECT COUNT(*) AS waiting FROM performance_schema.metadata_locks
            WHERE OBJECT_TYPE = 'USER LEVEL LOCK' AND LOCK_STATUS = 'PENDING'
              AND OBJECT_NAME = ${RELEASED_LOCK_NAME}`,
        )
        waiting = Number((pending as { waiting: unknown }[])[0]?.waiting)
      }
      const [tables] = await released.query(
        `SELECT COUNT(*) AS tables FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()`,
      )
      expect({
        waiting,
        settled,
        tablesWrittenMeanwhile: Number((tables as { tables: unknown }[])[0]?.tables),
      }).toEqual({ waiting: 1, settled: 'still waiting', tablesWrittenMeanwhile: 0 })

      await released.query(`SELECT RELEASE_LOCK(${RELEASED_LOCK_NAME}) AS released`)
      await migrating
      expect(settled).toBe('migrated')
      expect(await db.admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    } finally {
      await released.end().catch(() => undefined)
      await db.close()
    }
  }, 60_000)
})

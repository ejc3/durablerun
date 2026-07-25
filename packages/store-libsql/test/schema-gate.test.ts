import { SchemaMismatchError, StoreUnavailableError } from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlStoreAdmin,
  MIGRATIONS,
} from '../src/index.js'

/**
 * Two ways a database can be at the wrong schema version while every process
 * involved believes it is fine. Both become live hazards with migration v4,
 * because from v4 on EVERY compare-and-set names `fence_stamp` — so a binary
 * running against a v3 database fails not on one exotic path but on all of
 * them, on the first statement of the first batch.
 */

let db: LibsqlExecutor
let admin: LibsqlStoreAdmin

beforeEach(() => {
  db = LibsqlExecutor.open(':memory:')
  admin = new LibsqlStoreAdmin(db)
})

afterEach(() => {
  db.close()
})

/** Bring the database to `version` using the real shipped DDL. */
async function migrateTo(version: number): Promise<void> {
  await db.batch('setup:meta', [
    {
      sql: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
      args: [],
    },
    { sql: `INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, args: [String(version)] },
  ])
  for (const migration of MIGRATIONS.filter((m) => m.version <= version)) {
    await db.batch('setup:ddl', [
      ...migration.statements.map((sql) => ({ sql, args: [] as string[] })),
      {
        sql: `INSERT INTO meta (key, value) VALUES (?, '1')`,
        args: [`applied:v${migration.version}`],
      },
    ])
  }
}

describe('a database older than the binary', () => {
  /**
   * The damage this prevents: the store wraps every driver throw as
   * StoreUnavailableError, and `run-worker.ts` maps that type to "abort the
   * pass quietly, recover through the lease". So a missing column — a
   * permanent, deterministic configuration fault that no amount of waiting
   * repairs — is retried as though the database were merely busy. Every run
   * spends its whole infrastructure-retry budget and the task dies reporting
   * exhausted infrastructure, with the actual cause (an un-migrated database)
   * appearing nowhere. This is the same misclassification that made an
   * unserializable event payload burn 20 attempts; it must not survive at a
   * second layer.
   */
  it('classifies every SQLite schema-shape error as a permanent fault', async () => {
    await migrateTo(3)
    const cases = [
      `SELECT 1 FROM missing_table`,
      `SELECT fence_stamp FROM runs`,
      `INSERT INTO runs (missing_column) VALUES ('x')`,
      `ALTER TABLE runs ADD COLUMN task_id TEXT`,
    ]
    for (const sql of cases) {
      await expect(db.batch('probe', [{ sql, args: [] }], 'read'), sql).rejects.toBeInstanceOf(
        SchemaMismatchError,
      )
    }
  })

  it('still reports a genuinely unreachable database as an outage', async () => {
    await migrateTo(CURRENT_SCHEMA_VERSION)
    db.close()
    const error = await db
      .batch('probe', [{ sql: `SELECT 1`, args: [] }], 'read')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StoreUnavailableError)
  })
})

describe('migrate reports success only when the schema is current', () => {
  /**
   * The version bump is `UPDATE meta SET value = :n WHERE key = 'schema_version'
   * AND value = :n-1` — the same "a losing statement still writes" shape the
   * engine's own contract rule 1 forbids. Its guard can match zero rows while
   * the sentinel INSERT and the DDL in the same batch commit, and nothing
   * checks. The database is then physically migrated but records the old
   * version, and `migrate()` returns success.
   *
   * The next process to start is the one that pays: it reads the old version,
   * re-applies the DDL, and dies on `duplicate column name` — permanently,
   * on every restart. The deploy is wedged and the process that wedged it
   * reported success.
   *
   * A value that is numerically right and textually wrong is all it takes;
   * any tool that rewrites this row (a dump/restore, an operator, another
   * dialect's client) can produce one. Enumerating the causes is the wrong
   * response — asserting the post-condition covers all of them.
   */
  it('fails when the recorded version did not advance', async () => {
    await migrateTo(CURRENT_SCHEMA_VERSION - 1)
    await db.batch('corrupt', [
      {
        sql: `UPDATE meta SET value = ? WHERE key = 'schema_version'`,
        args: [`${CURRENT_SCHEMA_VERSION - 1} `],
      },
    ])

    await expect(admin.migrate()).rejects.toThrow(/schema/i)
  })

  it('is unaffected on a healthy database', async () => {
    await admin.migrate()
    await admin.migrate()
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
  })
})

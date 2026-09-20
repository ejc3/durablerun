import {
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlExecutor,
  StoreUnavailableError,
} from '@durablerun/core'
import { attributeReplacedFailure, requireExpectedFailure } from '@durablerun/core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlStoreAdmin,
  MIGRATIONS,
} from '../src/index.js'

const MISSED_VERSION_POSTCONDITION =
  `migrate finished with the schema recorded at version ${CURRENT_SCHEMA_VERSION - 1}, ` +
  `expected ${CURRENT_SCHEMA_VERSION} — the database is in an inconsistent state and must be repaired by hand`

function isMissedVersionPostcondition(error: unknown): boolean {
  return error instanceof SchemaMismatchError && error.message === MISSED_VERSION_POSTCONDITION
}

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

const captureSchemaVersion = (subject: LibsqlStoreAdmin) =>
  subject.schemaVersion().then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  )

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
      await attributeReplacedFailure(
        { kind: 'behavior', mutation: 'schema-fault-is-permanent' },
        {
          expectedError: (error) => error instanceof SchemaMismatchError,
          replacementError: (error) => error instanceof StoreUnavailableError,
        },
        () => db.batch('probe', [{ sql, args: [] }], 'read'),
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
   * This test changes only that real version-bump statement to miss. A
   * malformed stored value would be rejected before migration starts and
   * would therefore prove the decoder, not this post-condition.
   *
   * The version whose bump misses is the newest one, and the newest one can be
   * empty, as version 7 is on this dialect. Its batch then commits a sentinel
   * and no DDL, and the case holds what it is named for: `migrate()` refuses
   * when the recorded version did not advance, whatever the version's
   * statements were. The column read at the end shows that the versions before
   * it stayed applied. It never showed the missed version's own DDL.
   */
  it('fails when the recorded version did not advance', async () => {
    await migrateTo(CURRENT_SCHEMA_VERSION - 1)
    let changed = 0
    const versionBumpMiss: SqlExecutor = {
      batch: (label, statements, mode) =>
        db.batch(
          label,
          statements.map((statement) => {
            if (
              !label.startsWith('migrate:v') ||
              !/^\s*UPDATE meta SET value = \? WHERE key = 'schema_version' AND value = \?\s*$/.test(
                statement.sql,
              )
            ) {
              return statement
            }
            changed += 1
            return { ...statement, sql: `${statement.sql} AND 0 = 1` }
          }),
          mode,
        ),
    }
    const missingPostcondition = new LibsqlStoreAdmin(versionBumpMiss)

    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'migration-postcondition-old-version' },
      isMissedVersionPostcondition,
      () => missingPostcondition.migrate(),
    )
    expect(changed).toBe(1)

    const [version, columns] = await db.batch(
      'verify:partial-migration',
      [
        { sql: `SELECT value FROM meta WHERE key = 'schema_version'`, args: [] },
        { sql: `PRAGMA table_info(runs)`, args: [] },
      ],
      'read',
    )
    expect(version?.rows[0]?.value).toBe(String(CURRENT_SCHEMA_VERSION - 1))
    expect(columns?.rows.some((row) => row.name === 'fence_stamp')).toBe(true)
  })

  it('does not accept another schema mismatch as the missed-version postcondition', async () => {
    const unrelated = new SchemaMismatchError('an earlier schema decoder failed')
    const observed = await requireExpectedFailure(
      { kind: 'behavior', mutation: 'migration-postcondition-old-version' },
      isMissedVersionPostcondition,
      async () => {
        throw unrelated
      },
    ).then(
      () => 'accepted',
      (error: unknown) => error,
    )
    expect(observed).toBe(unrelated)
  })

  it('fails when the recorded version is not an integer', async () => {
    await migrateTo(0)
    await db.batch('corrupt', [
      {
        sql: `UPDATE meta SET value = 'garbage' WHERE key = 'schema_version'`,
        args: [],
      },
    ])

    await expect(admin.migrate()).rejects.toBeInstanceOf(SchemaMismatchError)
  })

  it('classifies a dialect-native bigint version as a schema mismatch', async () => {
    const malformed: SqlExecutor = {
      batch: async () => [
        {
          rows: [{ value: 1n as never }],
          rowsAffected: 0,
        },
      ],
    }

    await expect(new LibsqlStoreAdmin(malformed).schemaVersion()).rejects.toBeInstanceOf(
      SchemaMismatchError,
    )
  })

  it('does not mistake error text stored as the version for a fresh database', async () => {
    await migrateTo(0)
    await db.batch('corrupt', [
      {
        sql: `UPDATE meta SET value = 'no such table' WHERE key = 'schema_version'`,
        args: [],
      },
    ])

    await expect(admin.schemaVersion()).rejects.toBeInstanceOf(SchemaMismatchError)
  })

  it('owns typed schema absence without accepting deceptive failure text', async () => {
    const capture = (executor: SqlExecutor) =>
      new LibsqlStoreAdmin(executor).schemaVersion().then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
    const absent = new SchemaNotInitializedError('schema metadata has not been initialized')
    const deceptive = new StoreUnavailableError('proxy said no such table while disconnecting')
    const typedAbsence: SqlExecutor = {
      batch: async () => {
        throw absent
      },
    }
    const deceptiveFailure: SqlExecutor = {
      batch: async () => {
        throw deceptive
      },
    }

    const typed = await capture(typedAbsence)
    const text = await capture(deceptiveFailure)

    expect({ typed, text }, 'mutation-verdict:behavior:schema-absence-is-typed').toEqual({
      typed: { kind: 'resolved', value: 0 },
      text: { kind: 'rejected', error: deceptive },
    })
  })

  it('rejects a schema-version read with no result', async () => {
    const malformed: SqlExecutor = { batch: async () => [] }
    const observed = await captureSchemaVersion(new LibsqlStoreAdmin(malformed))

    expect(observed, 'mutation-verdict:behavior:schema-version-missing-result').toEqual({
      kind: 'rejected',
      error: expect.any(SchemaMismatchError),
    })
  })

  it('rejects a schema-version read with extra results', async () => {
    const current = { value: String(CURRENT_SCHEMA_VERSION) }
    const malformed: SqlExecutor = {
      batch: async () => [
        { rows: [current], rowsAffected: 1 },
        { rows: [current], rowsAffected: 1 },
      ],
    }
    const observed = await captureSchemaVersion(new LibsqlStoreAdmin(malformed))

    expect(observed, 'mutation-verdict:behavior:schema-version-extra-results').toEqual({
      kind: 'rejected',
      error: expect.any(SchemaMismatchError),
    })
  })

  it('rejects a schema-version read with no row', async () => {
    const malformed: SqlExecutor = {
      batch: async () => [{ rows: [], rowsAffected: 0 }],
    }
    const synthetic = await captureSchemaVersion(new LibsqlStoreAdmin(malformed))

    await db.batch('corrupt', [
      {
        sql: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
        args: [],
      },
    ])
    const initialized = await captureSchemaVersion(admin)
    const migration = await admin.migrate().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        name: error instanceof Error ? error.name : typeof error,
      }),
    )
    const [tables] = await db.batch(
      'probe',
      [
        {
          sql: `SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name`,
          args: [],
        },
      ],
      'read',
    )

    expect(
      {
        synthetic,
        initialized,
        migration,
        tables: tables?.rows.map((row) => row.name),
      },
      'mutation-verdict:behavior:schema-version-missing-row',
    ).toEqual({
      synthetic: { kind: 'rejected', error: expect.any(SchemaMismatchError) },
      initialized: { kind: 'rejected', error: expect.any(SchemaMismatchError) },
      migration: { kind: 'rejected', name: 'SchemaMismatchError' },
      tables: ['meta'],
    })
  })

  it('rejects a schema-version read with extra rows', async () => {
    const current = { value: String(CURRENT_SCHEMA_VERSION) }
    const malformed: SqlExecutor = {
      batch: async () => [{ rows: [current, current], rowsAffected: 2 }],
    }
    const observed = await captureSchemaVersion(new LibsqlStoreAdmin(malformed))

    expect(observed, 'mutation-verdict:behavior:schema-version-extra-rows').toEqual({
      kind: 'rejected',
      error: expect.any(SchemaMismatchError),
    })
  })

  it('fails when the recorded version is newer than this binary', async () => {
    await migrateTo(CURRENT_SCHEMA_VERSION)
    await db.batch('corrupt', [
      {
        sql: `UPDATE meta SET value = ? WHERE key = 'schema_version'`,
        args: [String(CURRENT_SCHEMA_VERSION + 1)],
      },
    ])

    // A newer build migrated this database and nothing in it is broken, so the refusal
    // says which build to run, and never to repair the database by hand.
    const refusal = await admin.migrate().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SchemaMismatchError)
    expect((refusal as Error).message).toMatch(/a newer build migrated this database/)
    expect((refusal as Error).message).not.toMatch(/repaired by hand/)
  })

  it('is unaffected on a healthy database', async () => {
    await admin.migrate()
    await admin.migrate()
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
  })
})

import {
  MAX_EPOCH_MS,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  type StoreAdmin,
  decodeBoundedInteger,
  requireEpochMs,
  storageValueKind,
} from '@durablerun/core'
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  type PostgresMigration,
  SCHEMA_VERSION_READ_SQL,
} from './schema.js'
import { NOW_MS } from './time.js'

export class PostgresStoreAdmin implements StoreAdmin {
  constructor(private readonly db: SqlExecutor) {}

  async migrate(): Promise<void> {
    // The executor turns undefined_table into this typed result only for the
    // canonical version read. No message matching occurs at this layer.
    if ((await this.readSchemaVersion()) === null) {
      await this.applyVersionedWrite(
        () =>
          this.db.batch('migrate:bootstrap', [
            {
              sql: `CREATE TABLE IF NOT EXISTS meta (
                      key TEXT PRIMARY KEY,
                      value TEXT NOT NULL
                    )`,
              args: [],
            },
            {
              sql: `INSERT INTO meta (key, value) VALUES ('schema_version', '0')
                    ON CONFLICT (key) DO NOTHING`,
              args: [],
            },
          ]),
        0,
      )
    }

    for (const migration of MIGRATIONS) {
      if ((await this.schemaVersion()) >= migration.version) continue
      await this.applyVersionedWrite(
        () => this.db.batch(`migrate:v${migration.version}`, fencedBatch(migration)),
        migration.version,
      )
    }

    const version = await this.schemaVersion()
    if (version !== CURRENT_SCHEMA_VERSION) {
      // A recorded version past this build's newest is a healthy schema that a newer build
      // migrated. It is refused like any other mismatch, with the advice that fits it.
      throw new SchemaMismatchError(
        version > CURRENT_SCHEMA_VERSION
          ? `the schema is recorded at version ${version} and this build knows versions up to ${CURRENT_SCHEMA_VERSION}: a newer build migrated this database, which needs no repair. Run that build or a later one`
          : `migrate finished with the schema recorded at version ${version}, expected ${CURRENT_SCHEMA_VERSION} — the database is in an inconsistent state and must be repaired by hand`,
      )
    }
  }

  /**
   * A concurrent migrator can win either the fresh-catalog bootstrap or a
   * version sentinel. PostgreSQL may report the losing CREATE as a catalog
   * uniqueness error even with IF NOT EXISTS, so the authoritative version —
   * not the error code — decides whether the write already completed.
   */
  private async applyVersionedWrite(
    write: () => Promise<unknown>,
    minimumVersion: number,
  ): Promise<void> {
    try {
      await write()
    } catch (error) {
      const version = await this.readSchemaVersion()
      if (version !== null && version >= minimumVersion) return
      throw error
    }
  }

  async schemaVersion(): Promise<number> {
    return (await this.readSchemaVersion()) ?? 0
  }

  private async readSchemaVersion(): Promise<number | null> {
    let results: SqlResult[]
    try {
      results = await this.db.batch(
        'migrate:version',
        [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
        'read',
      )
    } catch (error) {
      if (error instanceof SchemaNotInitializedError) return null
      throw error
    }

    const result = results.length === 1 ? results[0] : undefined
    const row = result?.rows.length === 1 ? result.rows[0] : undefined
    if (!row) {
      throw new SchemaMismatchError(
        `schema-version read must return exactly one result with one row, got ${results.length} results and ${result?.rows.length ?? 0} rows`,
      )
    }
    const stored = row.value
    if (typeof stored !== 'string' || !/^(0|[1-9][0-9]*)$/.test(stored)) {
      throw new SchemaMismatchError(
        `schema_version must be a canonical nonnegative integer, got ${storageValueKind(stored)}`,
      )
    }
    const version = Number(stored)
    if (!Number.isSafeInteger(version)) {
      throw new SchemaMismatchError(`schema_version is outside the safe integer range: ${stored}`)
    }
    return version
  }

  async setFakeNowEpochMs(epochMs: number | null): Promise<void> {
    if (epochMs === null) {
      await this.db.batch('admin:clear-fake-now', [
        { sql: `DELETE FROM meta WHERE key = 'fake_now_ms'`, args: [] },
      ])
      return
    }
    const validEpochMs = requireEpochMs('epochMs', epochMs)
    await this.db.batch('admin:set-fake-now', [
      {
        sql: `INSERT INTO meta (key, value) VALUES ('fake_now_ms', ?)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        args: [String(validEpochMs)],
      },
    ])
  }

  async nowEpochMs(): Promise<number> {
    const [result] = await this.db.batch(
      'admin:now',
      [{ sql: `SELECT ${NOW_MS} AS now_ms`, args: [] }],
      'read',
    )
    const raw = result?.rows[0]?.now_ms
    const decoded = decodeBoundedInteger(raw, { min: 0, max: MAX_EPOCH_MS })
    if (!decoded.ok) {
      throw new RangeError(
        `admin.now_ms must be an integer epoch-ms in [0, ${MAX_EPOCH_MS}] (${decoded.reason})`,
      )
    }
    return decoded.value
  }
}

function fencedBatch(migration: PostgresMigration): SqlStatement[] {
  return [
    // One migrator at a time, and the second one waits. This lock conflicts with itself and
    // with the row-exclusive lock a sentinel insert takes, so a second migrator stops here
    // holding nothing, and when the first has committed it loses to that sentinel. Without
    // it the second blocks on the first one's uncommitted sentinel while it holds its own
    // row-exclusive lock on meta, and a version that then locks the table deadlocks with
    // it, which PostgreSQL ends only after its deadlock timeout. A read does not conflict
    // with this lock, so the clock's row in meta stays readable while a version runs.
    { sql: 'LOCK TABLE meta IN SHARE ROW EXCLUSIVE MODE', args: [] },
    // Plain INSERT is the transaction fence. A stale or concurrent re-apply
    // raises unique_violation and rolls back its DDL with it.
    {
      sql: `INSERT INTO meta (key, value) VALUES ('applied:v${migration.version}', '1')`,
      args: [],
    },
    ...migration.statements.map((sql) => ({ sql, args: [] })),
    {
      sql: `UPDATE meta SET value = ? WHERE key = 'schema_version' AND value = ?`,
      args: [String(migration.version), String(migration.version - 1)],
    },
  ]
}

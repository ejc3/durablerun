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
  META_BOOTSTRAP_SQL,
  MIGRATIONS,
  type MysqlMigration,
  SCHEMA_VERSION_READ_SQL,
} from './schema.js'
import { NOW_MS } from './time.js'

export class MysqlStoreAdmin implements StoreAdmin {
  constructor(private readonly db: SqlExecutor) {}

  async migrate(): Promise<void> {
    // The executor turns a missing table into this typed result only for the
    // canonical version read. No message matching occurs at this layer.
    //
    // MySQL commits each DDL statement on its own, so no batch here is atomic
    // and no sentinel row could roll one back. Three things stand in for that.
    // The bootstrap is one statement, so the version table never exists without
    // its row. Every later statement is safe to repeat, so a migrator that died
    // halfway leaves work a rerun finishes. And the executor runs every
    // `migrate:` write under one named lock, so migrators take turns.
    if ((await this.readSchemaVersion()) === null) {
      await this.applyVersionedWrite(
        () => this.db.batch('migrate:bootstrap', [{ sql: META_BOOTSTRAP_SQL, args: [] }]),
        0,
      )
    }

    for (const migration of MIGRATIONS) {
      if ((await this.schemaVersion()) >= migration.version) continue
      await this.applyVersionedWrite(
        () => this.db.batch(`migrate:v${migration.version}`, versionBatch(migration)),
        migration.version,
      )
    }

    const version = await this.schemaVersion()
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        `migrate finished with the schema recorded at version ${version}, expected ${CURRENT_SCHEMA_VERSION} — the database is in an inconsistent state and must be repaired by hand`,
      )
    }
  }

  /**
   * A write that failed is complete only if the authoritative version says so: the
   * metadata now exists at or beyond the write's target. A concurrent migrator may have
   * won, or this migrator's own commit may have landed with only its answer lost. An
   * absent or behind version rethrows the original failure.
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
        { sql: "DELETE FROM meta WHERE `key` = 'fake_now_ms'", args: [] },
      ])
      return
    }
    const validEpochMs = requireEpochMs('epochMs', epochMs)
    await this.db.batch('admin:set-fake-now', [
      {
        sql: "INSERT INTO meta (`key`, value) VALUES ('fake_now_ms', ?) AS incoming ON DUPLICATE KEY UPDATE value = incoming.value",
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

/**
 * One version's statements, then the version itself, advanced only from the version
 * before it. A migrator that lost the race finds the version already advanced, matches no
 * row, and its repeatable statements changed nothing.
 */
function versionBatch(migration: MysqlMigration): SqlStatement[] {
  return [
    ...migration.statements.map((sql) => ({ sql, args: [] })),
    {
      sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version' AND value = ?",
      args: [String(migration.version), String(migration.version - 1)],
    },
  ]
}

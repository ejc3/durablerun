import {
  MAX_EPOCH_MS,
  MIGRATION_WRITE,
  type SqlExecutor,
  type SqlStatement,
  type StoreAdmin,
  applyVersionedWrite,
  decodeBoundedInteger,
  readSchemaVersion,
  requireCurrentSchemaVersion,
  requireEpochMs,
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
    //
    // The bootstrap names no migration lock, where every version's batch does. PostgreSQL's
    // migration lock is a lock on meta, which this batch is what creates. Racing bootstraps
    // converge without one: the batch is one transaction, and a loser is forgiven below.
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
        () =>
          this.db.batch(`migrate:v${migration.version}`, fencedBatch(migration), MIGRATION_WRITE),
        migration.version,
      )
    }

    requireCurrentSchemaVersion(await this.schemaVersion(), CURRENT_SCHEMA_VERSION)
  }

  private applyVersionedWrite(
    write: () => Promise<unknown>,
    minimumVersion: number,
  ): Promise<void> {
    return applyVersionedWrite(write, minimumVersion, () => this.readSchemaVersion())
  }

  async schemaVersion(): Promise<number> {
    return (await this.readSchemaVersion()) ?? 0
  }

  private readSchemaVersion(): Promise<number | null> {
    return readSchemaVersion(() =>
      this.db.batch('migrate:version', [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }], 'read'),
    )
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
    // The batch's control names the migration lock, which the executor takes ahead of this
    // sentinel, so a second migrator waits there holding nothing.
    //
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

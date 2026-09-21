import {
  MAX_EPOCH_MS,
  MIGRATION_WRITE,
  type SqlExecutor,
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
  type Migration,
  SCHEMA_VERSION_READ_SQL,
} from './schema.js'
import { NOW_MS } from './time.js'

export class LibsqlStoreAdmin implements StoreAdmin {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Applies each missing migration as ONE atomic batch that the runner
   * structurally fences (§3.4 rule 1 applied to migrations): a plain
   * `INSERT applied:vN` sentinel — its PK violation on any concurrent or
   * stale re-apply rolls the entire batch back — then the DDL, then the
   * version bump guarded on the previous version. A lost race re-reads the
   * version and continues; authors only ever write plain DDL.
   */
  async migrate(): Promise<void> {
    // Bootstrap is authorized only by the typed absence result from the exact
    // version read. CREATE IF NOT EXISTS cannot distinguish a fresh database
    // from an existing, initialized-but-corrupt empty meta table; running it
    // first launders the latter into a valid version-zero database.
    if ((await this.readSchemaVersion()) === null) {
      await this.applyVersionedWrite(async () => {
        await this.db.batch(
          'migrate:bootstrap',
          [
            {
              sql: `CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                  ) WITHOUT ROWID`,
              args: [],
            },
            {
              sql: `INSERT INTO meta (key, value) VALUES ('schema_version', '0')
                  ON CONFLICT (key) DO NOTHING`,
              args: [],
            },
          ],
          MIGRATION_WRITE,
        )
      }, 0)
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
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
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

function fencedBatch(migration: Migration): { sql: string; args: string[] }[] {
  return [
    // The structural fence: plain INSERT, no ON CONFLICT — any re-apply hits
    // the primary key and rolls the whole batch back atomically.
    {
      sql: `INSERT INTO meta (key, value) VALUES ('applied:v${migration.version}', '1')`,
      args: [],
    },
    ...migration.statements.map((sql) => ({ sql, args: [] as string[] })),
    {
      sql: `UPDATE meta SET value = ? WHERE key = 'schema_version' AND value = ?`,
      args: [String(migration.version), String(migration.version - 1)],
    },
  ]
}

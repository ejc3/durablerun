import type { SqlExecutor, StoreAdmin } from '@durablerun/core'
import { MIGRATIONS, type Migration } from './schema.js'
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
    await this.db.batch('migrate:bootstrap', [
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
    ])
    for (const migration of MIGRATIONS) {
      if ((await this.schemaVersion()) >= migration.version) continue
      try {
        await this.db.batch(`migrate:v${migration.version}`, fencedBatch(migration))
      } catch (error) {
        // A concurrent migrator may have won the sentinel race — that is
        // success, not failure. Anything else is real.
        if ((await this.schemaVersion()) >= migration.version) continue
        throw error
      }
    }
  }

  async schemaVersion(): Promise<number> {
    try {
      const [result] = await this.db.batch(
        'migrate:version',
        [{ sql: `SELECT value FROM meta WHERE key = 'schema_version'`, args: [] }],
        'read',
      )
      const row = result?.rows[0]
      return row ? Number(row.value) : 0
    } catch (error) {
      // Only a genuinely fresh database reads as version 0; a transient
      // network/auth error must not masquerade as one (it would re-apply
      // every migration over a live schema).
      if (String(error).includes('no such table')) return 0
      throw error
    }
  }

  async setFakeNowEpochMs(epochMs: number | null): Promise<void> {
    if (epochMs === null) {
      await this.db.batch('admin:clear-fake-now', [
        { sql: `DELETE FROM meta WHERE key = 'fake_now_ms'`, args: [] },
      ])
      return
    }
    await this.db.batch('admin:set-fake-now', [
      {
        sql: `INSERT INTO meta (key, value) VALUES ('fake_now_ms', ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        args: [String(epochMs)],
      },
    ])
  }

  async nowEpochMs(): Promise<number> {
    const [result] = await this.db.batch(
      'admin:now',
      [{ sql: `SELECT ${NOW_MS} AS now_ms`, args: [] }],
      'read',
    )
    return Number(result?.rows[0]?.now_ms)
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

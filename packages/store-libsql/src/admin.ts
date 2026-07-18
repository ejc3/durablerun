import type { SqlExecutor, StoreAdmin } from '@absurd-lite/core'
import { MIGRATIONS } from './schema.js'
import { NOW_MS } from './time.js'

export class LibsqlStoreAdmin implements StoreAdmin {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Applies each missing migration as one atomic batch (DDL + version bump
   * together), guarded by the stored schema_version — idempotent, crash-safe,
   * and safe to race: a concurrent migrator's batch either applied first
   * (version guard makes ours a no-op re-apply of IF NOT EXISTS DDL) or fails
   * whole and is retried.
   */
  async migrate(): Promise<void> {
    const current = await this.schemaVersion()
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      await this.db.batch(
        `migrate:v${migration.version}`,
        migration.statements.map((sql) => ({ sql, args: [] })),
      )
    }
  }

  async schemaVersion(): Promise<number> {
    try {
      const [result] = await this.db.batch('migrate:version', [
        { sql: `SELECT value FROM meta WHERE key = 'schema_version'`, args: [] },
      ])
      const row = result?.rows[0]
      return row ? Number(row.value) : 0
    } catch {
      // meta table does not exist yet — fresh database.
      return 0
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
    const [result] = await this.db.batch('admin:now', [
      { sql: `SELECT ${NOW_MS} AS now_ms`, args: [] },
    ])
    return Number(result?.rows[0]?.now_ms)
  }
}

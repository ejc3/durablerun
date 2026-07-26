import {
  SchemaMismatchError,
  type SqlExecutor,
  type SqlResult,
  type StoreAdmin,
} from '@durablerun/core'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, type Migration } from './schema.js'
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
    // The post-condition, asserted rather than assumed. Each version bump is
    // an UPDATE guarded on the previous value, in the same batch as the DDL —
    // exactly the "a losing statement still writes" shape rule 1 forbids in
    // engine SQL, and it was unchecked here. When the guard matches nothing
    // the DDL still commits, so the database ends up physically migrated
    // while recording the old version; the next process then re-applies the
    // DDL and dies on a duplicate column, on every restart, while the process
    // that caused it reported success. Checking the end state covers that and
    // every other cause without having to enumerate them.
    const version = await this.schemaVersion()
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        `migrate finished with the schema recorded at version ${version}, expected ${CURRENT_SCHEMA_VERSION} — the database is in an inconsistent state and must be repaired by hand`,
      )
    }
  }

  async schemaVersion(): Promise<number> {
    let results: SqlResult[]
    try {
      results = await this.db.batch(
        'migrate:version',
        [{ sql: `SELECT value FROM meta WHERE key = 'schema_version'`, args: [] }],
        'read',
      )
    } catch (error) {
      // Only a genuinely fresh database reads as version 0; a transient
      // network/auth error must not masquerade as one (it would re-apply
      // every migration over a live schema).
      if (String(error).includes('no such table')) return 0
      throw error
    }
    const row = results[0]?.rows[0]
    if (!row) return 0
    const stored = row.value
    if (typeof stored !== 'string' || !/^(0|[1-9][0-9]*)$/.test(stored)) {
      throw new SchemaMismatchError(
        `schema_version must be a canonical nonnegative integer, got ${JSON.stringify(stored)}`,
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

import {
  MAX_EPOCH_MS,
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

    // A batch is the unit of nothing here: a statement is what commits, and the lock is
    // what makes migrators take turns. So every version this database has yet to reach
    // goes out as one batch, after one read of the version and under one hold of the lock,
    // where a batch for each version cost a read and the lock each, the versions that hold
    // no statement included.
    //
    // The read comes before the lock, so the version can have moved by the time the batch
    // runs. That changes nothing a batch does: each version is advanced only from the one
    // before it, so a batch planned from a version that has moved repeats statements that
    // change nothing and then matches no row. It changes what a FAILED batch means. Another
    // migrator may be part of the way through, a released build's one version at a time
    // among them, so a failure is forgiven when the version has moved past the one this
    // batch was planned from, and what is still pending is then planned again. A failure
    // that moved nothing is rethrown, and a batch that reports success and moved nothing
    // ends the loop, so the post-condition below is what reports it.
    let recorded = await this.schemaVersion()
    for (;;) {
      const pending = MIGRATIONS.filter(({ version }) => version > recorded)
      const first = pending[0]
      const last = pending[pending.length - 1]
      if (first === undefined || last === undefined) break
      await this.applyVersionedWrite(
        () => this.db.batch(`migrate:v${last.version}`, pending.flatMap(versionBatch)),
        first.version,
      )
      const plannedFrom = recorded
      recorded = await this.schemaVersion()
      if (recorded <= plannedFrom) break
    }

    requireCurrentSchemaVersion(recorded, CURRENT_SCHEMA_VERSION)
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

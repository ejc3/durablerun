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
    // halfway leaves work a rerun finishes. And every migration write names the
    // migration lock in its control, which the executor takes before the batch and
    // refuses a migration write without, so migrators take turns.
    const found = await this.readSchemaVersion()
    if (found === null) {
      await this.applyVersionedWrite(
        () =>
          this.db.batch(
            'migrate:bootstrap',
            [{ sql: META_BOOTSTRAP_SQL, args: [] }],
            MIGRATION_WRITE,
          ),
        0,
      )
    }

    // A batch is the unit of nothing here: a statement is what commits, and the lock is
    // what makes migrators take turns. So every version this database has yet to reach
    // goes out as one batch, after one read of the version and under one hold of the lock,
    // where a batch for each version would cost a read and the lock each, the versions that
    // hold no statement included. A database that had its version table is planned from the
    // read that found it, so a process that starts on a current database reads once.
    //
    // The read comes before the lock, so the version can have moved by the time the batch
    // runs. That changes nothing a batch does: each version is advanced only from the one
    // before it, so a batch planned from a version that has moved repeats statements that
    // change nothing and then matches no row. It changes what a FAILED batch means. Another
    // migrator may be part of the way through, as one of the released build is between two
    // of its versions, so a failure is forgiven when the version has moved past the one this
    // batch was planned from, and what is still pending is then planned again. A failure
    // that moved nothing is rethrown, and a batch that reports success and moved nothing
    // ends the loop, so the post-condition below is what reports it.
    let recorded = found ?? (await this.schemaVersion())
    while (recorded < CURRENT_SCHEMA_VERSION) {
      const plannedFrom = recorded
      // What is left of the migration: every version after the recorded one, in order.
      const migration = MIGRATIONS.filter(({ version }) => version > plannedFrom)
      await this.applyVersionedWrite(
        () =>
          this.db.batch(
            `migrate:v${CURRENT_SCHEMA_VERSION}`,
            versionBatch(migration),
            MIGRATION_WRITE,
          ),
        plannedFrom + 1,
      )
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
 * The whole batch of what is left of a migration. `migration` is everything that is pending:
 * every version after the recorded one, in order, and one version when that is all there
 * is. For each version in turn the batch holds its statements, and then the version itself,
 * advanced only from the version before it. A migrator that lost the race finds the version
 * already advanced, matches no row, and its repeatable statements changed nothing.
 *
 * Every statement the batch sends is made here and nowhere else. The batch lint declares one
 * exception for this batch's statement list, and names it by the text of this call,
 * `versionBatch(migration)`, so what that text says has to stay true: the plan goes in, and
 * this one builder, whose statements the schema tests freeze, makes all that comes out.
 */
function versionBatch(migration: readonly MysqlMigration[]): SqlStatement[] {
  return migration.flatMap(({ version, statements }) => [
    ...statements.map((sql) => ({ sql, args: [] })),
    {
      sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version' AND value = ?",
      args: [String(version), String(version - 1)],
    },
  ])
}

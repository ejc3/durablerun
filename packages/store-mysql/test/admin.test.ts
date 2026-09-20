import {
  MAX_EPOCH_MS,
  MIGRATION_WRITE,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlBatchControl,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  StoreUnavailableError,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MysqlStoreAdmin } from '../src/admin.js'
import { CURRENT_SCHEMA_VERSION, META_BOOTSTRAP_SQL, MIGRATIONS } from '../src/schema.js'

class MigrationExecutor implements SqlExecutor {
  version: number | null = null
  readonly calls: {
    label: string
    statements: readonly SqlStatement[]
    control?: SqlBatchControl
  }[] = []
  /** What meets a version batch before it is applied: another migrator, a failure, or a write that is lost. */
  asAVersionBatchArrives?: () => undefined | 'reports success and writes nothing'

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    control?: SqlBatchControl,
  ): Promise<SqlResult[]> {
    this.calls.push({ label, statements, ...(control === undefined ? {} : { control }) })
    if (label === 'migrate:version') {
      if (this.version === null) {
        throw new SchemaNotInitializedError('schema metadata has not been initialized')
      }
      return [{ rows: [{ value: String(this.version) }], rowsAffected: 0 }]
    }
    if (label === 'migrate:bootstrap') {
      this.version = 0
      return statements.map(() => ({ rows: [], rowsAffected: 1 }))
    }
    if (label.startsWith('migrate:v')) {
      if ((await this.asAVersionBatchArrives?.()) === 'reports success and writes nothing') {
        return statements.map(() => ({ rows: [], rowsAffected: 0 }))
      }
      const versionWrite = statements.at(-1)
      const next = versionWrite?.args[0]
      if (typeof next !== 'string') throw new Error('migration did not end in a version write')
      this.version = Number(next)
      return statements.map(() => ({ rows: [], rowsAffected: 1 }))
    }
    throw new Error(`unexpected batch ${label}`)
  }
}

describe('MysqlStoreAdmin', () => {
  it('crosses every pending version with one version read and one batch, each version advanced only from the one before', async () => {
    const db = new MigrationExecutor()
    const admin = new MysqlStoreAdmin(db)
    const sent = () => db.calls.splice(0).map(({ label, control }) => [label, control])
    const advance = (version: number) => ({
      sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version' AND value = ?",
      args: [String(version), String(version - 1)],
    })
    // No sentinel row: MySQL commits DDL on its own, so a sentinel could not roll a version
    // back. The migration lock and repeatable statements stand in.
    const batchFrom = (after: number) =>
      MIGRATIONS.filter(({ version }) => version > after).flatMap(({ version, statements }) => [
        ...statements.map((sql) => ({ sql, args: [] })),
        advance(version),
      ])

    // A fresh database costs three version reads and two writes, however many versions
    // there are and however many of them hold no statement: the read that finds no version
    // table, the bootstrap, the read that says what is pending, one batch for all of it,
    // and the read that holds the result to the current version.
    await admin.migrate()
    const fresh = db.calls.find(({ label }) => label === `migrate:v${CURRENT_SCHEMA_VERSION}`)
    expect(fresh?.statements).toEqual(batchFrom(0))
    // Every migration write names the migration lock in its control, the bootstrap too: the
    // lock is a name, which can be taken before the version table exists.
    expect(
      sent(),
      'mutation-verdict:construction:mysql-pending-batch-names-the-migration-lock',
    ).toEqual([
      ['migrate:version', 'read'],
      ['migrate:bootstrap', MIGRATION_WRITE],
      ['migrate:version', 'read'],
      [`migrate:v${CURRENT_SCHEMA_VERSION}`, MIGRATION_WRITE],
      ['migrate:version', 'read'],
    ])
    expect(MIGRATIONS.filter(({ statements }) => statements.length === 0).length).toBeGreaterThan(1)

    // A database that is current is read once and not written: the read that finds its
    // version table is the one the plan is made from.
    await admin.migrate()
    expect(sent()).toEqual([['migrate:version', 'read']])

    // A database an older build left behind gets the versions after its own, and no other.
    db.version = 5
    await admin.migrate()
    const behind = db.calls.find(({ label }) => label === `migrate:v${CURRENT_SCHEMA_VERSION}`)
    expect(behind?.statements).toEqual(batchFrom(5))
    expect(sent()).toEqual([
      ['migrate:version', 'read'],
      [`migrate:v${CURRENT_SCHEMA_VERSION}`, MIGRATION_WRITE],
      ['migrate:version', 'read'],
    ])
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('plans again after a batch that failed while the version moved on, and only then', async () => {
    // The version is read before the lock is held, and a released build beside this one
    // migrates one version at a time, so a batch can fail while that migrator is part of
    // the way through: the 30 second lock wait is the failure that race produces. With the
    // batch forgiven only at its last version, this migrator would fail where nothing was
    // wrong. With it forgiven at no progress at all, a real failure would be swallowed.
    const lockWait = new StoreUnavailableError('could not take the durablerun:migrate lock')
    const migrating = async (meets: (db: MigrationExecutor) => void) => {
      const db = new MigrationExecutor()
      db.version = 1
      let arrivals = 0
      db.asAVersionBatchArrives = () => {
        arrivals += 1
        if (arrivals === 1) meets(db)
        return undefined
      }
      const outcome = await new MysqlStoreAdmin(db).migrate().then(
        () => 'migrated',
        (error: unknown) => (error === lockWait ? 'rethrew the lock wait' : String(error)),
      )
      // Planned from version 1 or later, a batch begins with an advance, whose second bind
      // is the version it advances from.
      const batchesPlannedFrom = db.calls
        .filter(({ label }) => /^migrate:v[0-9]+$/.test(label))
        .map(({ statements }) => statements[0]?.args[1])
      return { outcome, recorded: db.version, batchesPlannedFrom }
    }
    expect(
      {
        anotherMigratorWasPartOfTheWayThrough: await migrating((db) => {
          db.version = 3
          throw lockWait
        }),
        nothingMoved: await migrating(() => {
          throw lockWait
        }),
      },
      'mutation-verdict:construction:mysql-failed-batch-is-forgiven-where-the-version-moved',
    ).toEqual({
      anotherMigratorWasPartOfTheWayThrough: {
        outcome: 'migrated',
        recorded: CURRENT_SCHEMA_VERSION,
        batchesPlannedFrom: ['1', '3'],
      },
      nothingMoved: { outcome: 'rethrew the lock wait', recorded: 1, batchesPlannedFrom: ['1'] },
    })
  })

  it('sends one batch and then fails when a batch reports success and the version did not move', async () => {
    // A second batch is refused here, so that a migrator which plans again for ever fails
    // this case and does not hang it.
    const db = new MigrationExecutor()
    let arrivals = 0
    db.asAVersionBatchArrives = () => {
      arrivals += 1
      if (arrivals > 1) throw new Error('a second batch was sent, planned from the same version')
      return 'reports success and writes nothing'
    }
    const refusal = await new MysqlStoreAdmin(db).migrate().catch((error: unknown) => error)
    expect(
      refusal,
      'mutation-verdict:construction:mysql-migrator-plans-again-only-after-progress',
    ).toBeInstanceOf(SchemaMismatchError)
    expect(arrivals).toBe(1)
  })

  it('bootstraps in one statement that creates the version table with its row', async () => {
    // MySQL commits each DDL statement on its own. Two statements would leave the table
    // committed and its row not yet, which a concurrent version read reports as a
    // foreign database.
    const db = new MigrationExecutor()
    await new MysqlStoreAdmin(db).migrate()
    const bootstrap = db.calls.find(({ label }) => label === 'migrate:bootstrap')
    expect(
      bootstrap?.statements,
      'mutation-verdict:construction:mysql-bootstrap-is-one-statement',
    ).toEqual([{ sql: META_BOOTSTRAP_SQL, args: [] }])
    expect(META_BOOTSTRAP_SQL).toMatch(
      /^CREATE TABLE IF NOT EXISTS meta \([^;]*\) AS SELECT 'schema_version' AS `key`, '0' AS value$/,
    )
  })

  it('tells a build older than the schema to run a newer build, and never to repair', async () => {
    const db = new MigrationExecutor()
    db.version = CURRENT_SCHEMA_VERSION + 1
    const refusal = await new MysqlStoreAdmin(db).migrate().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SchemaMismatchError)
    expect((refusal as Error).message).toMatch(/a newer build migrated this database/)
    expect((refusal as Error).message).not.toMatch(/repaired by hand/)
    // It wrote nothing on the way to saying so.
    expect(db.calls.filter(({ control }) => control !== 'read')).toEqual([])
  })

  it('rejects malformed schema result shapes and noncanonical values', async () => {
    const cases: readonly SqlResult[][] = [
      [],
      [
        { rows: [{ value: '5' }], rowsAffected: 0 },
        { rows: [{ value: '5' }], rowsAffected: 0 },
      ],
      [{ rows: [], rowsAffected: 0 }],
      [{ rows: [{ value: '5' }, { value: '5' }], rowsAffected: 0 }],
      [{ rows: [{ value: 5n }], rowsAffected: 0 }],
      [{ rows: [{ value: '05' }], rowsAffected: 0 }],
      [{ rows: [{ value: String(Number.MAX_SAFE_INTEGER + 1) }], rowsAffected: 0 }],
    ]

    for (const results of cases) {
      const db: SqlExecutor = { batch: async () => results }
      await expect(new MysqlStoreAdmin(db).schemaVersion()).rejects.toBeInstanceOf(
        SchemaMismatchError,
      )
    }
  })

  it('validates fake time before writing and decodes native BIGINT results exactly', async () => {
    const writes: readonly SqlStatement[][] = []
    const mutableWrites = writes as SqlStatement[][]
    const db: SqlExecutor = {
      batch: async (label, statements) => {
        if (label === 'admin:now') {
          return [{ rows: [{ now_ms: BigInt(MAX_EPOCH_MS) }], rowsAffected: 0 }]
        }
        mutableWrites.push([...statements])
        return statements.map(() => ({ rows: [], rowsAffected: 1 }))
      },
    }
    const admin = new MysqlStoreAdmin(db)

    await expect(admin.setFakeNowEpochMs(-1)).rejects.toBeInstanceOf(RangeError)
    expect(writes).toEqual([])
    await admin.setFakeNowEpochMs(MAX_EPOCH_MS)
    expect(writes[0]?.[0]?.args).toEqual([String(MAX_EPOCH_MS)])
    expect(await admin.nowEpochMs()).toBe(MAX_EPOCH_MS)
  })
})

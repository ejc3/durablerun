import {
  MAX_EPOCH_MS,
  MIGRATION_WRITE,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlBatchControl,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/schema.js'

class MigrationExecutor implements SqlExecutor {
  version: number | null = null
  readonly calls: {
    label: string
    statements: readonly SqlStatement[]
    control?: SqlBatchControl
  }[] = []

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
      const versionWrite = statements.at(-1)
      const next = versionWrite?.args[0]
      if (typeof next !== 'string') throw new Error('migration did not end in a version write')
      this.version = Number(next)
      return statements.map(() => ({ rows: [], rowsAffected: 1 }))
    }
    throw new Error(`unexpected batch ${label}`)
  }
}

describe('PostgresStoreAdmin', () => {
  it('migrates a typed-fresh database through every fenced version', async () => {
    const db = new MigrationExecutor()
    const admin = new PostgresStoreAdmin(db)

    expect(await admin.schemaVersion()).toBe(0)
    await admin.migrate()
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)

    const migrationCalls = db.calls.filter(({ label }) => /^migrate:v[0-9]+$/.test(label))
    expect(migrationCalls.map(({ label }) => label)).toEqual(
      MIGRATIONS.map(({ version }) => `migrate:v${version}`),
    )
    // The bootstrap names no lock: PostgreSQL's migration lock is a lock on the table that
    // the bootstrap creates.
    expect(db.calls.find(({ label }) => label === 'migrate:bootstrap')?.control).toBeUndefined()
    for (const [index, call] of migrationCalls.entries()) {
      const migration = MIGRATIONS[index]
      // The control names the lock that makes a second migrator wait, which the executor
      // takes ahead of every statement. Then the sentinel, which comes before every
      // statement of the version, then the version's statements and nothing else.
      expect(
        call?.control,
        'mutation-verdict:construction:postgres-version-batch-names-the-migration-lock',
      ).toBe(MIGRATION_WRITE)
      expect(call?.statements).toHaveLength((migration?.statements.length ?? 0) + 2)
      expect(call?.statements[0]?.sql).toBe(
        `INSERT INTO meta (key, value) VALUES ('applied:v${migration?.version}', '1')`,
      )
      expect(call?.statements.slice(1, -1).map(({ sql }) => sql)).toEqual(migration?.statements)
      expect(call?.statements.at(-1)).toEqual({
        sql: `UPDATE meta SET value = ? WHERE key = 'schema_version' AND value = ?`,
        args: [String(migration?.version), String((migration?.version ?? 0) - 1)],
      })
    }
  })

  it('tells a build older than the schema to run a newer build, and never to repair', async () => {
    const db = new MigrationExecutor()
    db.version = CURRENT_SCHEMA_VERSION + 1
    const refusal = await new PostgresStoreAdmin(db).migrate().catch((error: unknown) => error)
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
      await expect(new PostgresStoreAdmin(db).schemaVersion()).rejects.toBeInstanceOf(
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
    const admin = new PostgresStoreAdmin(db)

    await expect(admin.setFakeNowEpochMs(-1)).rejects.toBeInstanceOf(RangeError)
    expect(writes).toEqual([])
    await admin.setFakeNowEpochMs(MAX_EPOCH_MS)
    expect(writes[0]?.[0]?.args).toEqual([String(MAX_EPOCH_MS)])
    expect(await admin.nowEpochMs()).toBe(MAX_EPOCH_MS)
  })
})

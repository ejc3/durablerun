import {
  MAX_EPOCH_MS,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MysqlStoreAdmin } from '../src/admin.js'
import { CURRENT_SCHEMA_VERSION, META_BOOTSTRAP_SQL, MIGRATIONS } from '../src/schema.js'

class MigrationExecutor implements SqlExecutor {
  version: number | null = null
  readonly calls: { label: string; statements: readonly SqlStatement[]; mode?: SqlBatchMode }[] = []

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    mode?: SqlBatchMode,
  ): Promise<SqlResult[]> {
    this.calls.push({ label, statements, ...(mode === undefined ? {} : { mode }) })
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

describe('MysqlStoreAdmin', () => {
  it('migrates a typed-fresh database through every version, each advanced only from the one before', async () => {
    const db = new MigrationExecutor()
    const admin = new MysqlStoreAdmin(db)

    expect(await admin.schemaVersion()).toBe(0)
    await admin.migrate()
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)

    const migrationCalls = db.calls.filter(({ label }) => /^migrate:v[0-9]+$/.test(label))
    expect(migrationCalls.map(({ label }) => label)).toEqual(
      MIGRATIONS.map(({ version }) => `migrate:v${version}`),
    )
    for (const [index, call] of migrationCalls.entries()) {
      const migration = MIGRATIONS[index]
      // No sentinel row: MySQL commits DDL on its own, so a sentinel could not roll a
      // version back. The executor's migration lock and repeatable statements stand in.
      expect(call?.statements.map(({ sql }) => sql).slice(0, -1)).toEqual(migration?.statements)
      expect(call?.statements.at(-1)).toEqual({
        sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version' AND value = ?",
        args: [String(migration?.version), String((migration?.version ?? 0) - 1)],
      })
    }
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

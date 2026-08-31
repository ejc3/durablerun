import {
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_TEMPORAL_FIELDS,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SqlExecutor,
  type SqlResult,
  StoreUnavailableError,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { PersistedNumericTable, StoreFixture, StoreFixtureFactory } from './fixture.js'

type PersistedIntegerObservation = Readonly<{
  table: PersistedNumericTable
  column: string
  integerBits: 16 | 32 | 64
  nullable: boolean
}>

const EXPECTED_PERSISTED_INTEGERS = Object.freeze(
  [
    ...PERSISTED_COUNTER_FIELDS.map(({ table, column }) => ({
      table,
      column,
      integerBits: 64 as const,
      nullable: false,
    })),
    ...PERSISTED_TEMPORAL_FIELDS.map(({ table, column, nullable }) => ({
      table,
      column,
      integerBits: 64 as const,
      nullable,
    })),
  ].sort(comparePersistedFields) satisfies PersistedIntegerObservation[],
)

const PERSISTED_NUMERIC_TABLES = Object.freeze([
  ...new Set(EXPECTED_PERSISTED_INTEGERS.map(({ table }) => table)),
] as PersistedNumericTable[])

function comparePersistedFields(
  left: Pick<PersistedIntegerObservation, 'table' | 'column'>,
  right: Pick<PersistedIntegerObservation, 'table' | 'column'>,
): number {
  return `${left.table}.${left.column}`.localeCompare(`${right.table}.${right.column}`)
}

function schemaVersionExecutor(results: readonly SqlResult[]): SqlExecutor {
  return { batch: async () => [...results] }
}

function nativeIntegerBits(nativeType: string): 16 | 32 | 64 | null {
  switch (nativeType.trim()) {
    // SQLite preserves the declared spelling; its INTEGER storage class is
    // signed 64-bit. PostgreSQL/MySQL information-schema names are lowercase.
    case 'SMALLINT':
    case 'INT2':
    case 'smallint':
    case 'int2':
      return 16
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
    case 'INT8':
      return 64
    case 'int':
    case 'integer':
    case 'int4':
      return 32
    case 'bigint':
    case 'int8':
      return 64
    default:
      return null
  }
}

async function setStoredSchemaVersion(fixture: StoreFixture, value: string): Promise<void> {
  const [result] = await fixture.raw.batch('fixture:set-schema-version', [
    {
      sql: `UPDATE meta SET value = ? WHERE key = 'schema_version'`,
      args: [value],
    },
  ])
  if (result?.rowsAffected !== 1) {
    throw new Error(`schema-version setup updated ${result?.rowsAffected ?? 0} rows instead of one`)
  }
}

async function persistedIntegerInventory(
  fixture: StoreFixture,
): Promise<PersistedIntegerObservation[]> {
  const statements = fixture.persistedIntegerCatalogStatements(PERSISTED_NUMERIC_TABLES)
  if (statements.length === 0) {
    throw new Error('persisted integer catalog inspection must contain at least one statement')
  }
  const results = await fixture.raw.batch('fixture:persisted-integer-catalog', statements, 'read')
  if (results.length !== statements.length) {
    throw new Error(
      `persisted integer catalog returned ${results.length} results for ${statements.length} statements`,
    )
  }

  const observed: PersistedIntegerObservation[] = []
  const catalogFields = new Set<string>()
  for (const result of results) {
    for (const row of result.rows) {
      const table = row.table_name
      const column = row.column_name
      const nativeType = row.native_type
      const nullable = row.nullable
      if (
        typeof table !== 'string' ||
        !PERSISTED_NUMERIC_TABLES.includes(table as PersistedNumericTable) ||
        typeof column !== 'string' ||
        typeof nativeType !== 'string' ||
        !(nullable === 0 || nullable === 0n || nullable === 1 || nullable === 1n)
      ) {
        throw new Error(
          `malformed persisted integer catalog row: ${JSON.stringify({
            table,
            column,
            nativeType,
            nullable: typeof nullable === 'bigint' ? String(nullable) : nullable,
          })}`,
        )
      }
      const field = `${table}.${column}`
      if (catalogFields.has(field)) {
        throw new Error(`persisted integer catalog returned duplicate field ${field}`)
      }
      catalogFields.add(field)
      const integerBits = nativeIntegerBits(nativeType)
      if (integerBits === null) continue
      observed.push({
        table: table as PersistedNumericTable,
        column,
        integerBits,
        nullable: nullable === 1 || nullable === 1n,
      } as PersistedIntegerObservation)
    }
  }
  return observed.sort(comparePersistedFields)
}

function captureSchemaVersion(admin: StoreFixture['admin']) {
  return admin.schemaVersion().then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  )
}

export function schemaAdminConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`schema/admin conformance [${dialect}]`, () => {
    it('migrates a genuinely fresh database to one canonical current version', async () => {
      const fixture = await makeFixture('schema-admin-fresh', { migrate: false })
      try {
        expect(await fixture.admin.schemaVersion()).toBe(0)
        await fixture.admin.migrate()
        const current = await fixture.admin.schemaVersion()
        expect(Number.isSafeInteger(current)).toBe(true)
        expect(current).toBeGreaterThan(0)

        await fixture.admin.migrate()
        expect(await fixture.admin.schemaVersion()).toBe(current)
      } finally {
        await fixture.close()
      }
    })

    it('lets concurrent cold-start migrators converge on the current schema', async () => {
      const fixture = await makeFixture('schema-admin-concurrent-fresh', { migrate: false })
      try {
        const migrations = await Promise.allSettled(
          Array.from({ length: 8 }, () => fixture.admin.migrate()),
        )

        expect(migrations.map(({ status }) => status)).toEqual(
          Array.from({ length: 8 }, () => 'fulfilled'),
        )
        expect(await fixture.admin.schemaVersion()).toBeGreaterThan(0)
      } finally {
        await fixture.close()
      }
    })

    it('accepts only canonical nonnegative safe base-10 schema versions', async () => {
      const fixture = await makeFixture('schema-admin-canonical')
      try {
        const current = await fixture.admin.schemaVersion()
        const canonical = ['0', '1', '42', String(Number.MAX_SAFE_INTEGER)]
        const accepted: { stored: string; decoded: number }[] = []
        for (const stored of canonical) {
          await setStoredSchemaVersion(fixture, stored)
          accepted.push({ stored, decoded: await fixture.admin.schemaVersion() })
        }

        const noncanonical = [
          '',
          '00',
          '01',
          '+1',
          '-1',
          '1.0',
          '1e0',
          ' 1',
          '1 ',
          String(Number.MAX_SAFE_INTEGER + 1),
          'no such table: meta',
        ]
        const rejected: { stored: string; mismatch: boolean }[] = []
        for (const stored of noncanonical) {
          await setStoredSchemaVersion(fixture, stored)
          const outcome = await captureSchemaVersion(fixture.admin)
          rejected.push({
            stored,
            mismatch: outcome.kind === 'rejected' && outcome.error instanceof SchemaMismatchError,
          })
        }

        expect({ accepted, rejected }).toEqual({
          accepted: canonical.map((stored) => ({ stored, decoded: Number(stored) })),
          rejected: noncanonical.map((stored) => ({ stored, mismatch: true })),
        })

        await setStoredSchemaVersion(fixture, String(current + 1))
        await expect(fixture.admin.migrate()).rejects.toBeInstanceOf(SchemaMismatchError)
      } finally {
        await fixture.close()
      }
    })

    it('treats only an actually absent metadata table or typed absence as fresh', async () => {
      const fixture = await makeFixture('schema-admin-absence', { migrate: false })
      try {
        expect(await fixture.admin.schemaVersion()).toBe(0)
        await fixture.raw.batch('fixture:create-empty-meta', [
          {
            sql: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
            args: [],
          },
        ])
        await expect(fixture.admin.schemaVersion()).rejects.toBeInstanceOf(SchemaMismatchError)
        let migrationWrites = 0
        const observedAdmin = fixture.adminOver({
          batch: (label, statements, mode) => {
            if (mode !== 'read') migrationWrites += 1
            return fixture.raw.batch(label, statements, mode)
          },
        })
        await expect(observedAdmin.migrate()).rejects.toBeInstanceOf(SchemaMismatchError)
        expect(migrationWrites).toBe(0)

        const typedAbsence = new SchemaNotInitializedError(
          'schema metadata has not been initialized',
        )
        const deceptiveOutage = new StoreUnavailableError(
          'proxy said no such table: meta while disconnecting',
        )
        const typedAdmin = fixture.adminOver({
          batch: async () => {
            throw typedAbsence
          },
        })
        const deceptiveAdmin = fixture.adminOver({
          batch: async () => {
            throw deceptiveOutage
          },
        })

        expect({
          typed: await captureSchemaVersion(typedAdmin),
          deceptive: await captureSchemaVersion(deceptiveAdmin),
        }).toEqual({
          typed: { kind: 'resolved', value: 0 },
          deceptive: { kind: 'rejected', error: deceptiveOutage },
        })
      } finally {
        await fixture.close()
      }
    })

    it('rejects every malformed schema-version result vector', async () => {
      const fixture = await makeFixture('schema-admin-result-shape')
      try {
        const current = String(await fixture.admin.schemaVersion())
        const malformed = [
          { id: 'no-result', results: [] },
          {
            id: 'extra-results',
            results: [
              { rows: [{ value: current }], rowsAffected: 1 },
              { rows: [{ value: current }], rowsAffected: 1 },
            ],
          },
          { id: 'no-row', results: [{ rows: [], rowsAffected: 0 }] },
          {
            id: 'extra-rows',
            results: [
              {
                rows: [{ value: current }, { value: current }],
                rowsAffected: 2,
              },
            ],
          },
          {
            id: 'non-text',
            results: [{ rows: [{ value: 1 }], rowsAffected: 1 }],
          },
          {
            id: 'bigint',
            results: [{ rows: [{ value: 1n }], rowsAffected: 1 }],
          },
          {
            id: 'blob',
            results: [{ rows: [{ value: new Uint8Array([49]) }], rowsAffected: 1 }],
          },
          {
            id: 'null',
            results: [{ rows: [{ value: null }], rowsAffected: 1 }],
          },
        ] satisfies readonly { id: string; results: readonly SqlResult[] }[]

        const outcomes = []
        for (const { id, results } of malformed) {
          const outcome = await captureSchemaVersion(
            fixture.adminOver(schemaVersionExecutor(results)),
          )
          outcomes.push({
            id,
            mismatch: outcome.kind === 'rejected' && outcome.error instanceof SchemaMismatchError,
          })
        }
        expect(outcomes).toEqual(malformed.map(({ id }) => ({ id, mismatch: true })))
      } finally {
        await fixture.close()
      }
    })

    it('rejects a migration that reports success without advancing its version', async () => {
      const fixture = await makeFixture('schema-admin-missed-version', { migrate: false })
      try {
        let suppressedMigrationWrites = 0
        const stalledMigration: SqlExecutor = {
          batch: (label, statements, mode) => {
            if (label === 'migrate:version') {
              return fixture.raw.batch(label, statements, mode)
            }
            if (label === 'migrate:bootstrap' || label.startsWith('migrate:v')) {
              suppressedMigrationWrites += 1
              return Promise.resolve(statements.map(() => ({ rows: [], rowsAffected: 0 })))
            }
            return fixture.raw.batch(label, statements, mode)
          },
        }

        await expect(fixture.adminOver(stalledMigration).migrate()).rejects.toBeInstanceOf(
          SchemaMismatchError,
        )
        expect(suppressedMigrationWrites).toBeGreaterThan(0)
      } finally {
        await fixture.close()
      }
    })

    it('enrolls every persisted native-integer column with exact nullability', async () => {
      const fixture = await makeFixture('schema-admin-integer-inventory')
      try {
        const observed = await persistedIntegerInventory(fixture)
        expect(
          observed,
          'mutation-verdict:construction:migrated-integer-inventory-complete',
        ).toEqual(EXPECTED_PERSISTED_INTEGERS)
        expect(observed).toHaveLength(31)
      } finally {
        await fixture.close()
      }
    })
  })
}

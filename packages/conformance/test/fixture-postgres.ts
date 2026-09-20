import type { Buggify, SqlExecutor } from '@durablerun/core'
import { PostgresSchedulerStore, PostgresStoreAdmin } from '@durablerun/store-postgres'
import {
  openPostgresTestDb,
  postgresPersistedIntegerCatalogStatements,
} from '@durablerun/store-postgres/testing'
import {
  type StorageCorruption,
  type StorageCorruptionAttempt,
  type StoreFixture,
  type StoreFixtureOptions,
  corruptionTarget,
  unboundedOverWidthAttempt,
} from '../src/index.js'
import { conformanceIdNamespace } from './fixture-id-namespace.js'

const STRUCTURAL_NUMERIC_SQLSTATES = new Set([
  '22003', // numeric_value_out_of_range
  '22021', // character_not_in_repertoire
  '22P02', // invalid_text_representation
  '42804', // datatype_mismatch
  '42846', // cannot_coerce
])

function sqlState(error: unknown): string | undefined {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== 'object' || current === null) return undefined
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown }
    if (typeof candidate.code === 'string') return candidate.code
    current = candidate.cause
  }
  return undefined
}

function storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt {
  if (corruption.invalidRepresentation === 'over-width') {
    return unboundedOverWidthAttempt(corruption)
  }
  const fractionalValue =
    corruption.column === 'max_attempts' ||
    corruption.column === 'attempt' ||
    corruption.column === 'lease_ms' ||
    corruption.column === 'owner_attempt'
      ? 1.5
      : 0.5
  const value =
    corruption.invalidRepresentation === 'non-integer'
      ? 'bad-integer'
      : corruption.invalidRepresentation === 'fractional-real'
        ? fractionalValue
        : new Uint8Array([0xff])
  const assignment =
    corruption.invalidRepresentation === 'non-text' ? "convert_from(CAST(? AS BYTEA), 'UTF8')" : '?'

  const { table, where, identityArgs } = corruptionTarget(corruption)

  return {
    statements: [
      {
        sql: `UPDATE ${table} SET ${corruption.column} = ${assignment} WHERE ${where}`,
        args: [value, ...identityArgs],
      },
    ],
    isStructuralRejection: (error) => {
      const state = sqlState(error)
      return state !== undefined && STRUCTURAL_NUMERIC_SQLSTATES.has(state)
    },
    verify: () => {
      throw new Error(
        `PostgreSQL accepted invalid ${corruption.invalidRepresentation} storage for ${table}.${corruption.column}`,
      )
    },
  }
}

export async function makePostgresFixture(
  seed: number | string,
  options: StoreFixtureOptions = {},
): Promise<StoreFixture> {
  const opened = await openPostgresTestDb({
    idNamespace: conformanceIdNamespace(seed),
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  })
  const { raw, admin, ids } = opened
  return {
    store: new PostgresSchedulerStore(raw, ids),
    admin,
    adminOver: (db: SqlExecutor) => new PostgresStoreAdmin(db),
    raw,
    persistedIntegerCatalogStatements: postgresPersistedIntegerCatalogStatements,
    schemaVersionTable: {
      setVersion: (value: string) => ({
        sql: `UPDATE meta SET value = ? WHERE key = 'schema_version'`,
        args: [value],
      }),
      createEmpty: () => ({
        sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        args: [],
      }),
    },
    storageCorruptionAttempt,
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new PostgresSchedulerStore(db, ids, buggify),
    deadlocks: () => raw.deadlocks,
    close: opened.close,
  }
}

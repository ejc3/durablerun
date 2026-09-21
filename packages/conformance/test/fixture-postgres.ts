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
  nullPayloadAttempt,
  unboundedOverWidthAttempt,
} from '../src/index.js'
import { firstInCauseChain, isString } from './fixture-error-chain.js'
import { conformanceIdNamespace } from './fixture-id-namespace.js'

const STRUCTURAL_NUMERIC_SQLSTATES = new Set([
  '22003', // numeric_value_out_of_range
  '22021', // character_not_in_repertoire
  '22P02', // invalid_text_representation
  '42804', // datatype_mismatch
  '42846', // cannot_coerce
])

const sqlState = (error: unknown) => firstInCauseChain(error, 'code', isString)

const NOT_NULL_VIOLATION = '23502'

function storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt {
  if (corruption.invalidRepresentation === 'over-width') {
    return unboundedOverWidthAttempt(corruption)
  }
  if (corruption.invalidRepresentation === 'null') {
    return nullPayloadAttempt(corruption, (error) => sqlState(error) === NOT_NULL_VIOLATION)
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
  const store = new PostgresSchedulerStore(raw, ids)
  return {
    store,
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
    lockWait: async () => ({
      store,
      raw,
      holdWriteLock: (taskId: string, during: () => Promise<void>) =>
        opened.holdTaskRowLock(taskId, during),
      shortenFirst: [],
      // PostgreSQL waits at the locked row, inside the batch, until its lock_timeout.
      shortenInside: [{ sql: "SET LOCAL lock_timeout = '100ms'", args: [] }],
      close: async () => {},
    }),
    close: opened.close,
  }
}

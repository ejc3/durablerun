import type { Buggify, SqlExecutor } from '@durablerun/core'
import { META_TABLE_SQL, MysqlSchedulerStore, MysqlStoreAdmin } from '@durablerun/store-mysql'
import {
  mysqlPersistedIntegerCatalogStatements,
  openMysqlTestDb,
} from '@durablerun/store-mysql/testing'
import {
  type StorageCorruption,
  type StorageCorruptionAttempt,
  type StoreFixture,
  type StoreFixtureOptions,
  corruptionTarget,
  nullPayloadAttempt,
  overWidthWrite,
} from '../src/index.js'
import { firstInCauseChain, isNumber } from './fixture-error-chain.js'
import { conformanceIdNamespace } from './fixture-id-namespace.js'

/** MySQL errors that mean a column's type refused the value, under the strict mode every session sets. */
const STRUCTURAL_VALUE_ERRNOS = new Set([
  1264, // ER_WARN_DATA_OUT_OF_RANGE
  1265, // WARN_DATA_TRUNCATED
  1292, // ER_TRUNCATED_WRONG_VALUE
  1366, // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD
])

const mysqlErrno = (error: unknown) => firstInCauseChain(error, 'errno', isNumber)

/** A scalar subquery that returns two rows: MySQL refuses it only when it is evaluated. */
const ER_SUBQUERY_NO_1_ROW = 1242

/** A string longer than its column holds, which strict mode refuses and does not cut. */
const ER_DATA_TOO_LONG = 1406

/** `Column cannot be null`, which is an error under the strict mode every session sets. */
const ER_BAD_NULL_ERROR = 1048

function storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt {
  if (corruption.invalidRepresentation === 'null') {
    return nullPayloadAttempt(corruption, (error) => mysqlErrno(error) === ER_BAD_NULL_ERROR)
  }
  if (corruption.invalidRepresentation === 'over-width') {
    return {
      statements: [overWidthWrite(corruption)],
      isStructuralRejection: (error) => mysqlErrno(error) === ER_DATA_TOO_LONG,
      verify: () => {
        throw new Error(`MySQL accepted a name past the width in tasks.${corruption.column}`)
      },
    }
  }
  const { table, where, identityArgs } = corruptionTarget(corruption)
  const accepted = (): never => {
    throw new Error(
      `MySQL accepted invalid ${corruption.invalidRepresentation} storage for ${table}.${corruption.column}`,
    )
  }

  if (corruption.invalidRepresentation === 'fractional-real') {
    // MySQL does not refuse a fraction bound for a BIGINT column. It rounds it, in
    // strict mode too (measured: 1.5 stored as 2, 0.5 as 0, with no error or warning).
    // So the column cannot hold the corrupt value, but no error says so. The attempt
    // therefore writes a fraction to the real column, then reads the column back in
    // the same transaction and aborts unless what is stored is fractional. The write
    // adds less than a half to the stored value, so it rounds back to that value and
    // cannot collide with a unique key on its way to being rolled back.
    const column = corruption.column
    return {
      statements: [
        {
          sql: `UPDATE ${table} SET ${column} = COALESCE(${column}, 0) + ? WHERE ${where}`,
          args: [0.25, ...identityArgs],
        },
        {
          sql: `SELECT CASE
                  WHEN EXISTS (SELECT 1 FROM ${table}
                               WHERE ${where} AND ${column} <> FLOOR(${column}))
                  THEN 1
                  ELSE (SELECT 1 UNION ALL SELECT 2)
                END AS holds_a_fraction`,
          args: identityArgs,
        },
      ],
      isStructuralRejection: (error) => mysqlErrno(error) === ER_SUBQUERY_NO_1_ROW,
      verify: accepted,
    }
  }

  const value =
    corruption.invalidRepresentation === 'non-integer' ? 'bad-integer' : new Uint8Array([0xff])
  return {
    statements: [
      {
        sql: `UPDATE ${table} SET ${corruption.column} = ? WHERE ${where}`,
        args: [value, ...identityArgs],
      },
    ],
    isStructuralRejection: (error) => {
      const errno = mysqlErrno(error)
      return errno !== undefined && STRUCTURAL_VALUE_ERRNOS.has(errno)
    },
    verify: accepted,
  }
}

export async function makeMysqlFixture(
  seed: number | string,
  options: StoreFixtureOptions = {},
): Promise<StoreFixture> {
  const opened = await openMysqlTestDb({
    idNamespace: conformanceIdNamespace(seed),
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  })
  const { raw, admin, ids } = opened
  const store = new MysqlSchedulerStore(raw, ids)
  return {
    store,
    admin,
    adminOver: (db: SqlExecutor) => new MysqlStoreAdmin(db),
    raw,
    persistedIntegerCatalogStatements: mysqlPersistedIntegerCatalogStatements,
    schemaVersionTable: {
      setVersion: (value: string) => ({
        sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version'",
        args: [value],
      }),
      createEmpty: () => ({ sql: META_TABLE_SQL, args: [] }),
    },
    storageCorruptionAttempt,
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new MysqlSchedulerStore(db, ids, buggify),
    deadlocks: () => raw.deadlocks,
    lockWait: async () => ({
      store,
      raw,
      holdWriteLock: (taskId: string, during: () => Promise<void>) =>
        opened.holdTaskRowLock(taskId, during),
      shortenFirst: [],
      // MySQL waits at the locked row until innodb_lock_wait_timeout, set in whole seconds.
      shortenInside: [{ sql: 'SET SESSION innodb_lock_wait_timeout = 1', args: [] }],
      close: async () => {},
    }),
    close: opened.close,
  }
}

import type { Buggify, SqlExecutor } from '@durablerun/core'
import { META_TABLE_SQL, MysqlSchedulerStore, MysqlStoreAdmin } from '@durablerun/store-mysql'
import {
  openMysqlTestDb,
  mysqlPersistedIntegerCatalogStatements,
} from '@durablerun/store-mysql/testing'
import type {
  StorageCorruption,
  StorageCorruptionAttempt,
  StoreFixture,
  StoreFixtureOptions,
} from '../src/index.js'
import { conformanceIdNamespace } from './fixture-id-namespace.js'

/** MySQL errors that mean a column's type refused the value, under the strict mode every session sets. */
const STRUCTURAL_VALUE_ERRNOS = new Set([
  1264, // ER_WARN_DATA_OUT_OF_RANGE
  1265, // WARN_DATA_TRUNCATED
  1292, // ER_TRUNCATED_WRONG_VALUE
  1366, // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD
])

function mysqlErrno(error: unknown): number | undefined {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== 'object' || current === null) return undefined
    const candidate = current as { readonly errno?: unknown; readonly cause?: unknown }
    if (typeof candidate.errno === 'number') return candidate.errno
    current = candidate.cause
  }
  return undefined
}

/** A scalar subquery that returns two rows: MySQL refuses it only when it is evaluated. */
const ER_SUBQUERY_NO_1_ROW = 1242

function storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt {
  let table: 'checkpoints' | 'drivers' | 'events' | 'runs' | 'tasks' | 'waits'
  let where: string
  let identityArgs: string[]
  switch (corruption.table) {
    case 'tasks':
      table = 'tasks'
      where = 'task_id = ?'
      identityArgs = [corruption.taskId]
      break
    case 'runs':
      table = 'runs'
      where = 'run_id = ?'
      identityArgs = [corruption.runId]
      break
    case 'checkpoints':
      table = 'checkpoints'
      where = 'task_id = ? AND checkpoint_name = ?'
      identityArgs = [corruption.taskId, corruption.checkpointName]
      break
    case 'events':
      table = 'events'
      where = 'queue = ? AND event_name = ?'
      identityArgs = [corruption.queue, corruption.eventName]
      break
    case 'waits':
      table = 'waits'
      where = 'run_id = ? AND step_name = ?'
      identityArgs = [corruption.runId, corruption.stepName]
      break
    case 'drivers':
      table = 'drivers'
      where = 'queue = ? AND driver_id = ?'
      identityArgs = [corruption.queue, corruption.driverId]
      break
  }
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
  return {
    store: new MysqlSchedulerStore(raw, ids),
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
    close: opened.close,
  }
}

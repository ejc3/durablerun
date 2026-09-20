import type { Buggify, SqlExecutor } from '@durablerun/core'
import { LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import {
  type PersistedNumericTable,
  type StorageCorruption,
  type StorageCorruptionAttempt,
  type StoreFixture,
  type StoreFixtureOptions,
  corruptionTarget,
  unboundedOverWidthAttempt,
} from '../src/index.js'
import { conformanceIdNamespace } from './fixture-id-namespace.js'

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function persistedIntegerCatalogStatements(tables: readonly PersistedNumericTable[]) {
  return tables.map((table) => {
    const tableLiteral = sqlStringLiteral(table)
    return {
      sql: `SELECT ${tableLiteral} AS table_name,
                   name AS column_name,
                   type AS native_type,
                   CASE WHEN "notnull" = 0 THEN 1 ELSE 0 END AS nullable
            FROM pragma_table_info(${tableLiteral})`,
      args: [],
    }
  })
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
      ? 'bad-time'
      : corruption.invalidRepresentation === 'fractional-real'
        ? fractionalValue
        : new Uint8Array([112, 111, 105, 115, 111, 110])
  const { table, where, identityArgs } = corruptionTarget(corruption)
  return {
    statements: [
      {
        sql: `UPDATE ${table} SET ${corruption.column} = ? WHERE ${where}`,
        args: [value, ...identityArgs],
      },
      {
        sql: `SELECT typeof(${corruption.column}) AS storage_type,
                     ${corruption.column} AS stored_value
              FROM ${table} WHERE ${where}`,
        args: identityArgs,
      },
    ],
    isStructuralRejection: () => false,
    verify: (results) => {
      const observed = results[1]
      const expectedStorageType =
        corruption.invalidRepresentation === 'non-integer'
          ? 'text'
          : corruption.invalidRepresentation === 'fractional-real'
            ? 'real'
            : 'blob'
      const row = observed?.rows[0]
      if (
        row?.storage_type !== expectedStorageType ||
        (corruption.invalidRepresentation !== 'non-text' && row.stored_value !== value)
      ) {
        throw new Error(
          `storage corruption was not preserved as ${expectedStorageType} ${String(value)}; got ${String(row?.storage_type)} ${String(row?.stored_value)}`,
        )
      }
    },
  }
}

export async function makeLibsqlFixture(
  seed: number | string,
  options: StoreFixtureOptions = {},
): Promise<StoreFixture> {
  // Resume from a timer. Nothing else on the libSQL path lets the event loop turn, and a
  // worker whose loop does not turn for a minute fails its run with every test passing.
  // It has to be a timer. Run in a worker thread: a blocking stretch that resumes from a
  // timer callback has a waiting reply handled before a deadline armed during it, and one
  // that resumes from setImmediate, which Clock.yieldTurn uses, meets the deadline first.
  // fixture-libsql-yields.test.ts holds this line.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const { raw, admin, ids } = await openTestDb({
    idNamespace: conformanceIdNamespace(seed),
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  })
  return {
    store: new LibsqlSchedulerStore(raw, ids),
    admin,
    adminOver: (db: SqlExecutor) => new LibsqlStoreAdmin(db),
    raw,
    persistedIntegerCatalogStatements,
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
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new LibsqlSchedulerStore(db, ids, buggify),
    // SQLite has one writer at a time and never picks a victim: a writer that cannot get
    // the lock waits out its busy timeout and fails, and the executor runs nothing again.
    deadlocks: () => 0,
    close: async () => raw.close(),
  }
}

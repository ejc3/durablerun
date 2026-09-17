import type { StoreTables, TreeDialect } from '@durablerun/core'
import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely'
import { NOW_MS } from './time.js'

/**
 * libSQL statement trees. The builder never connects: it only builds trees, which a
 * batch compiles with this dialect's compiler and the database clock expression.
 */
export const TREE_DIALECT: TreeDialect = Object.freeze({
  compiler: new SqliteQueryCompiler(),
  now: NOW_MS,
})

export const tree = new Kysely<StoreTables>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
})

import type { StoreTables, TreeDialect } from '@durablerun/core'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { NOW_MS } from './time.js'

/** PostgreSQL SQL with the executor port's `?` binds, which the executor numbers itself. */
class PostgresBindCompiler extends PostgresQueryCompiler {
  protected override getCurrentParameterPlaceholder(): string {
    return '?'
  }
}

/**
 * PostgreSQL statement trees. The builder never connects: it only builds trees, which
 * a batch compiles with this dialect's compiler and the database clock expression.
 */
export const TREE_DIALECT: TreeDialect = Object.freeze({
  compiler: new PostgresBindCompiler(),
  now: NOW_MS,
})

export const tree = new Kysely<StoreTables>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresBindCompiler(),
  },
})

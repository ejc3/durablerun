import { TreeDialect } from '@durablerun/core'
import { SqliteQueryCompiler } from 'kysely'

/** How libSQL compiles a statement tree. Kysely is a compiler here, never a client. */
export const TREE_DIALECT = new TreeDialect(new SqliteQueryCompiler())

import { TreeDialect } from '@durablerun/core'
import { PostgresQueryCompiler } from 'kysely'

/** PostgreSQL SQL with the executor port's `?` binds, which the executor numbers itself. */
class PostgresBindCompiler extends PostgresQueryCompiler {
  protected override getCurrentParameterPlaceholder(): string {
    return '?'
  }
}

/** How PostgreSQL compiles a statement tree. Kysely is a compiler here, never a client. */
export const TREE_DIALECT = new TreeDialect(new PostgresBindCompiler())

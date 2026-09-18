import type { StoreFixtureFactory } from '../src/index.js'
import { type EnrolledDialect, parseDialectSelection } from './dialect-selection.js'
import { makeLibsqlFixture } from './fixture-libsql.js'
import { makeMysqlFixture } from './fixture-mysql.js'
import { makePostgresFixture } from './fixture-postgres.js'

export const DIALECT_FIXTURES: readonly {
  dialect: EnrolledDialect
  makeFixture: StoreFixtureFactory
}[] = [
  { dialect: 'libsql', makeFixture: makeLibsqlFixture },
  { dialect: 'postgres', makeFixture: makePostgresFixture },
  { dialect: 'mysql', makeFixture: makeMysqlFixture },
]

/** The dialects one run exercises: every enrolled one, or the ones the selection names. */
export function selectedDialects(
  selection: string | undefined = process.env.DURABLERUN_CONFORMANCE_DIALECTS,
): readonly string[] {
  return parseDialectSelection(selection)
}

/** The enrolled fixtures this run exercises, in enrollment order. */
const SELECTED = selectedDialects()
export const SELECTED_DIALECT_FIXTURES = DIALECT_FIXTURES.filter(({ dialect }) =>
  SELECTED.includes(dialect),
)

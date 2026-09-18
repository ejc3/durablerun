import type { StoreFixtureFactory } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'
import { makeMysqlFixture } from './fixture-mysql.js'
import { makePostgresFixture } from './fixture-postgres.js'

export const DIALECT_FIXTURES: readonly {
  dialect: string
  makeFixture: StoreFixtureFactory
}[] = [
  { dialect: 'libsql', makeFixture: makeLibsqlFixture },
  { dialect: 'postgres', makeFixture: makePostgresFixture },
  { dialect: 'mysql', makeFixture: makeMysqlFixture },
]

/**
 * The dialects one run exercises. Every dialect is enrolled above and runs by default.
 * `DURABLERUN_CONFORMANCE_DIALECTS` narrows a run to the servers it has, as a comma
 * list, so CI can give each server its own parallel job. A name that is not enrolled,
 * or a list that selects nothing, fails the run: a narrowed gate must never be an
 * empty one.
 */
export function selectedDialects(
  selection: string | undefined = process.env.DURABLERUN_CONFORMANCE_DIALECTS,
): readonly string[] {
  const enrolled = DIALECT_FIXTURES.map(({ dialect }) => dialect)
  if (selection === undefined) return enrolled
  const names = selection.split(',').map((name) => name.trim())
  const unknown = names.filter((name) => !enrolled.includes(name))
  if (names.length === 0 || unknown.length > 0 || new Set(names).size !== names.length) {
    throw new Error(
      `DURABLERUN_CONFORMANCE_DIALECTS must list distinct enrolled dialects (${enrolled.join(', ')}), got '${selection}'`,
    )
  }
  return enrolled.filter((dialect) => names.includes(dialect))
}

/** The enrolled fixtures this run exercises, in enrollment order. */
export const SELECTED_DIALECT_FIXTURES = DIALECT_FIXTURES.filter(({ dialect }) =>
  selectedDialects().includes(dialect),
)

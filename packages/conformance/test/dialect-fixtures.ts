import type { StoreFixtureFactory } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'
import { makePostgresFixture } from './fixture-postgres.js'

export const DIALECT_FIXTURES: readonly {
  dialect: string
  makeFixture: StoreFixtureFactory
}[] = [
  { dialect: 'libsql', makeFixture: makeLibsqlFixture },
  { dialect: 'postgres', makeFixture: makePostgresFixture },
]

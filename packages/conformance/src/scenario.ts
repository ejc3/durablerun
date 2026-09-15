import type { SqlExecutor, SqlRow, SqlStatement } from '@durablerun/core'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'

/** Run one raw statement and return its first row. */
export async function readOne(
  raw: SqlExecutor,
  sql: string,
  args: SqlStatement['args'],
): Promise<SqlRow | undefined> {
  const [result] = await raw.batch('t', [{ sql, args }])
  return result?.rows[0]
}

/** Run `body` against its own fixture, and close the fixture even when the body throws. */
export async function withFixture<T>(
  makeFixture: StoreFixtureFactory,
  name: number | string,
  body: (fixture: StoreFixture) => Promise<T>,
): Promise<T> {
  const fixture = await makeFixture(name)
  try {
    return await body(fixture)
  } finally {
    await fixture.close()
  }
}

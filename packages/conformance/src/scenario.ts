import type { SqlExecutor, SqlRow, SqlStatement } from '@durablerun/core'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'

/** Run one raw statement in read mode and return its first row. */
export async function readOne(
  raw: SqlExecutor,
  sql: string,
  args: SqlStatement['args'],
): Promise<SqlRow | undefined> {
  const [result] = await raw.batch('t', [{ sql, args }], 'read')
  return result?.rows[0]
}

/**
 * Run `body` against its own fixture and close the fixture afterwards, including
 * when the body throws. If closing fails after the body threw, the thrown error
 * names the close failure and carries the body's error as its cause, which the
 * test report prints with its assertion diff.
 */
export async function withFixture<T>(
  makeFixture: StoreFixtureFactory,
  name: number | string,
  body: (fixture: StoreFixture) => Promise<T>,
): Promise<T> {
  const fixture = await makeFixture(name)
  let result: T
  try {
    result = await body(fixture)
  } catch (scenarioFailure) {
    try {
      await fixture.close()
    } catch (closeFailure) {
      throw new Error(`closing the fixture failed after the scenario failed: ${closeFailure}`, {
        cause: scenarioFailure,
      })
    }
    throw scenarioFailure
  }
  await fixture.close()
  return result
}

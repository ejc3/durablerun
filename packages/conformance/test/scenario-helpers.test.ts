import { type SqlBatchControl, type SqlExecutor, sqlBatchMode } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from '../src/index.js'
import { readOne, withFixture } from '../src/scenario.js'

/** A fixture whose only live member is close, which counts calls and may fail. */
function closingFixture(closeFailure?: Error): {
  makeFixture: StoreFixtureFactory
  closes: () => number
} {
  let closes = 0
  const fixture = {
    async close() {
      closes++
      if (closeFailure) throw closeFailure
    },
  } as unknown as StoreFixture
  return { makeFixture: async () => fixture, closes: () => closes }
}

const outcome = (promise: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )

describe('conformance scenario helpers', () => {
  it('readOne runs its statement in read mode', async () => {
    const modes: string[] = []
    const recording: SqlExecutor = {
      async batch(_label, _statements, control?: SqlBatchControl) {
        modes.push(sqlBatchMode(control))
        return [{ rows: [{ n: 1 }], rowsAffected: 1 }]
      },
    }
    expect(await readOne(recording, 'SELECT 1 AS n', [])).toEqual({ n: 1 })
    expect(modes).toEqual(['read'])
  })

  it('withFixture returns the scenario value and closes the fixture once', async () => {
    const { makeFixture, closes } = closingFixture()
    expect(await outcome(withFixture(makeFixture, 'ok', async () => 'done'))).toEqual({
      value: 'done',
    })
    expect(closes()).toBe(1)
  })

  it('withFixture closes the fixture when the scenario fails', async () => {
    const scenarioFailure = new Error('scenario failed')
    const { makeFixture, closes } = closingFixture()
    const observed = await outcome(
      withFixture(makeFixture, 'failing', async () => {
        throw scenarioFailure
      }),
    )
    expect(observed).toEqual({ error: scenarioFailure })
    expect(closes()).toBe(1)
  })

  it('withFixture keeps the scenario failure when closing the fixture also fails', async () => {
    const scenarioFailure = new Error('scenario failed')
    const closeFailure = new Error('close failed')
    const { makeFixture, closes } = closingFixture(closeFailure)
    const observed = await outcome(
      withFixture(makeFixture, 'double-failure', async () => {
        throw scenarioFailure
      }),
    )
    expect(observed.error).toBeInstanceOf(Error)
    expect((observed.error as Error).message).toContain('close failed')
    expect((observed.error as Error).cause).toBe(scenarioFailure)
    expect(closes()).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../src/fuzz.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

describe('fuzz walk regressions', () => {
  it('keeps walking after a write to a run its task cancellation ended (seed 64, 100 steps)', async () => {
    const outcome = await runFuzzScenario(makeLibsqlFixture, 64, 100).then(
      () => 'walked',
      (error: unknown) => String(error),
    )
    expect(outcome).toBe('walked')
  }, 120_000)
})

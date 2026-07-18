import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../src/fuzz.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 15)
const STEPS = Number(process.env.FUZZ_STEPS ?? 60)

describe(`operation fuzz (${SEEDS} seeds x ${STEPS} steps)`, () => {
  it('upholds the engine invariants on every seeded walk', async () => {
    const failures: string[] = []
    for (let seed = 0; seed < SEEDS; seed++) {
      try {
        await runFuzzScenario(makeLibsqlFixture, seed, STEPS)
      } catch (error) {
        failures.push(`seed ${seed}: ${String(error)}`)
      }
    }
    expect(failures).toEqual([])
  }, 120_000)
})

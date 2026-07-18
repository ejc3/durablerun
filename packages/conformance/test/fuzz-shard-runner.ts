import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../src/fuzz.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

function knob(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}='${raw}' is not a positive integer — refusing a vacuous fuzz run`)
  }
  return value
}
const SEEDS = knob('FUZZ_SEEDS', 64)
const STEPS = knob('FUZZ_STEPS', 60)

/**
 * Fuzz seeds are sharded across test FILES because vitest parallelizes
 * files onto worker threads — libsql calls are synchronous native, so
 * in-process pooling cannot use the cores; thread-per-file can.
 */
export function runFuzzShard(shard: number, of: number): void {
  describe(`operation fuzz shard ${shard}/${of} (${SEEDS} total seeds x ${STEPS} steps)`, () => {
    it('upholds the engine invariants on every seeded walk', async () => {
      const failures: string[] = []
      for (let seed = shard; seed < SEEDS; seed += of) {
        try {
          await runFuzzScenario(makeLibsqlFixture, seed, STEPS)
        } catch (error) {
          failures.push(`seed ${seed}: ${String(error)}`)
        }
      }
      expect(failures).toEqual([])
    }, 600_000)
  })
}

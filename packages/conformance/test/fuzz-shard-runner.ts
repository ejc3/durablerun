import { describe, expect, it } from 'vitest'
import { type FuzzStats, runFuzzScenario } from '../src/fuzz.js'
import { describeFailure } from '../src/scenario.js'
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

function zeroBasedKnob(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name}='${raw}' is not a nonnegative integer — refusing a vacuous fuzz run`)
  }
  return value
}

const SEEDS = knob('FUZZ_SEEDS', 64)
const STEPS = knob('FUZZ_STEPS', 60)
const BATCH_COUNT = knob('FUZZ_BATCHES', 1)
const BATCH = zeroBasedKnob('FUZZ_BATCH_INDEX', 0)

export interface FuzzBatchCoordinates {
  readonly totalSeeds: number
  readonly shard: number
  readonly shardCount: number
  readonly batch: number
  readonly batchCount: number
}

/**
 * The single seed-ownership definition for ordinary and bounded-process fuzz.
 *
 * A logical shard owns one residue modulo `shardCount`; its process batches
 * partition that residue by the seed's ordinal within the shard. A malformed
 * coordinate or empty process is rejected rather than credited as a green
 * fuzz leg.
 */
export function fuzzBatchSeeds({
  totalSeeds,
  shard,
  shardCount,
  batch,
  batchCount,
}: FuzzBatchCoordinates): readonly number[] {
  for (const [name, value] of [
    ['totalSeeds', totalSeeds],
    ['shardCount', shardCount],
    ['batchCount', batchCount],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer, got ${value}`)
    }
  }
  for (const [name, value, upper] of [
    ['shard', shard, shardCount],
    ['batch', batch, batchCount],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value >= upper) {
      throw new RangeError(`${name} must be an integer in [0, ${upper}), got ${value}`)
    }
  }

  const seeds: number[] = []
  for (let seed = shard + batch * shardCount; seed < totalSeeds; seed += shardCount * batchCount) {
    seeds.push(seed)
  }
  if (seeds.length === 0) {
    throw new RangeError(
      `fuzz batch ${batch}/${batchCount} of shard ${shard}/${shardCount} owns no seeds`,
    )
  }
  return seeds
}

/**
 * Fuzz seeds are sharded across test FILES because vitest parallelizes
 * files onto worker threads — libsql calls are synchronous native, so
 * in-process pooling cannot use the cores; thread-per-file can.
 */
export function runFuzzShard(shard: number, of: number): void {
  const seeds = fuzzBatchSeeds({
    totalSeeds: SEEDS,
    shard,
    shardCount: of,
    batch: BATCH,
    batchCount: BATCH_COUNT,
  })
  describe(`operation fuzz shard ${shard}/${of}, batch ${BATCH}/${BATCH_COUNT} (${seeds.length} of ${SEEDS} total seeds x ${STEPS} steps)`, () => {
    it('upholds the engine invariants on every seeded walk', async () => {
      const failures: string[] = []
      const totals: FuzzStats = {
        spawnsCreated: 0,
        claims: 0,
        activates: 0,
        completes: 0,
        fails: 0,
        reschedules: 0,
        checkpoints: 0,
        sweepTransitions: 0,
        cancels: 0,
        nextWakes: 0,
        emits: 0,
        awaits: 0,
      }
      let walks = 0
      for (const seed of seeds) {
        try {
          const stats = await runFuzzScenario(makeLibsqlFixture, seed, STEPS)
          walks++
          for (const key of Object.keys(totals) as (keyof FuzzStats)[]) {
            totals[key] += stats[key]
          }
        } catch (error) {
          failures.push(`seed ${seed}: ${describeFailure(error)}`)
        }
      }
      expect(failures).toEqual([])
      // Aggregate per-op floors: across a whole shard of long walks, every
      // core transition must have SUCCEEDED somewhere — "complete stopped
      // working entirely" must fail even though each individual walk still
      // makes progress via the other ops. (Per-walk floors would pin one
      // unlucky seed as a deterministic failure; aggregates cannot.)
      if (walks >= 20 && STEPS >= 50) {
        for (const key of Object.keys(totals) as (keyof FuzzStats)[]) {
          if (totals[key] === 0) {
            failures.push(`op '${key}' never succeeded across ${walks} walks x ${STEPS} steps`)
          }
        }
        expect(failures).toEqual([])
      }
    }, 600_000)
  })
}

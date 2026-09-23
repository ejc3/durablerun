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

/**
 * A batch index has no default. Unset, the process was given no index and runs every batch.
 * An empty value is refused as knob() refuses one: Number('') is 0, so a workflow that built
 * the index from a misspelled key would walk batch 0 only and report a green shard.
 */
function indexKnob(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name}='${raw}' is not a nonnegative integer — refusing a vacuous fuzz run`)
  }
  return value
}

const SEEDS = knob('FUZZ_SEEDS', 64)
const STEPS = knob('FUZZ_STEPS', 60)
const BATCH_COUNT = knob('FUZZ_BATCHES', 1)
const BATCH_INDEX = indexKnob('FUZZ_BATCH_INDEX')

export interface FuzzBatchCoordinates {
  readonly totalSeeds: number
  readonly shard: number
  readonly shardCount: number
  readonly batch: number
  readonly batchCount: number
}

/**
 * A stat too rare for the common floor holds its floor from this many walked steps in a
 * shard. A saga is halted by one pass move in ten, behind a claimed pass with a rollback
 * owed. Measured on libSQL with a correct store: a halt was named in 248 of 6,000 walks of
 * 50 steps and in 386 of 3,720 walks of 100 steps, and 121 of 300 shards of twenty walks
 * of 50 steps named none. At the size of `verify:fuzz`, 62 walks of 100 steps, that rate
 * misses in about one shard of nine hundred, which is one run in thirty. So the floor
 * starts at 20,000 steps. The rate grows faster than a walk's length, so what a shard of
 * that size misses depends on its walks: about five in a hundred million for walks of 50
 * steps, and under one in a billion for walks of 100 steps or more. Nothing but the
 * nightly plan test ties the nightly's batch to this size: it holds every batch at or
 * above it, so a batch count or a seed count that would switch this floor off fails there.
 * The check itself runs at the end of every walk of every size. Only the floor waits for
 * a shard large enough.
 */
export const RARE_STAT_FLOOR_STEPS: Partial<Record<keyof FuzzStats, number>> = {
  haltsNamed: 20_000,
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
  for (const batch of fuzzProcessBatches(BATCH_COUNT, BATCH_INDEX)) runFuzzBatch(shard, of, batch)
}

/**
 * The batches one process runs. The hosted nightly starts a fresh process for each batch and
 * names it with FUZZ_BATCH_INDEX. A process given a batch count and no index runs every batch,
 * each as its own test with its own time budget: an unset index once meant batch 0, so a run
 * that set FUZZ_BATCHES alone walked one batch of its seeds and reported a green shard.
 */
export function fuzzProcessBatches(
  batchCount: number,
  batchIndex: number | undefined,
): readonly number[] {
  if (batchIndex !== undefined) return [batchIndex]
  return Array.from({ length: batchCount }, (_, batch) => batch)
}

function runFuzzBatch(shard: number, of: number, batch: number): void {
  const seeds = fuzzBatchSeeds({
    totalSeeds: SEEDS,
    shard,
    shardCount: of,
    batch,
    batchCount: BATCH_COUNT,
  })
  describe(`operation fuzz shard ${shard}/${of}, batch ${batch}/${BATCH_COUNT} (${seeds.length} of ${SEEDS} total seeds x ${STEPS} steps)`, () => {
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
        childAwaits: 0,
        recordedEndings: 0,
        stepsStarted: 0,
        sagasEntered: 0,
        rollbacks: 0,
        rollbackFailures: 0,
        sagasEnded: 0,
        haltsNamed: 0,
        portStringRefusals: 0,
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
          if (totals[key] === 0 && walks * STEPS >= (RARE_STAT_FLOOR_STEPS[key] ?? 0)) {
            failures.push(`op '${key}' never succeeded across ${walks} walks x ${STEPS} steps`)
          }
        }
        expect(failures).toEqual([])
      }
    }, 600_000)
  })
}

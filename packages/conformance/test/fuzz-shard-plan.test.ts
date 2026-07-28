import { describe, expect, it } from 'vitest'
import { fuzzBatchSeeds } from './fuzz-shard-runner.js'

describe('fuzz shard batch plan', () => {
  it('partitions every nightly seed exactly once into bounded fresh-process batches', () => {
    const totalSeeds = 20_000
    const shardCount = 32
    const batchCount = 4
    const planned: number[] = []

    for (let shard = 0; shard < shardCount; shard++) {
      for (let batch = 0; batch < batchCount; batch++) {
        const seeds = fuzzBatchSeeds({ totalSeeds, shard, shardCount, batch, batchCount })
        expect(seeds.length).toBeGreaterThan(0)
        expect(seeds.length).toBeLessThanOrEqual(160)
        expect(seeds.every((seed) => seed % shardCount === shard)).toBe(true)
        planned.push(...seeds)
      }
    }

    expect(new Set(planned).size).toBe(totalSeeds)
    expect(planned.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: totalSeeds }, (_, seed) => seed),
    )
  })

  it('rejects empty, overlapping, or out-of-range plan coordinates', () => {
    const valid = { totalSeeds: 64, shard: 0, shardCount: 32, batch: 0, batchCount: 2 }
    for (const override of [
      { totalSeeds: 0 },
      { shard: -1 },
      { shard: 32 },
      { shardCount: 0 },
      { batch: -1 },
      { batch: 2 },
      { batchCount: 0 },
    ]) {
      expect(() => fuzzBatchSeeds({ ...valid, ...override })).toThrow(RangeError)
    }
  })
})

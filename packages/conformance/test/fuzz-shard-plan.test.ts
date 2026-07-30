import { readFileSync } from 'node:fs'
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
    expect(() =>
      fuzzBatchSeeds({
        totalSeeds: 1,
        shard: 1,
        shardCount: 2,
        batch: 0,
        batchCount: 1,
      }),
    ).toThrow(/owns no seeds/)
  })

  it('enrolls every logical shard and bounded batch in the hosted nightly', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/nightly.yml', import.meta.url),
      'utf8',
    )
    const shardVector = workflow.match(/shard:\s*\[([^\]]+)\]/)?.[1]
    expect(shardVector).toBeDefined()
    expect(shardVector?.split(',').map((value) => Number(value.trim()))).toEqual(
      Array.from({ length: 32 }, (_, shard) => shard),
    )
    expect(workflow).toContain('for batch in 0 1 2 3')
    expect(workflow).toContain('FUZZ_BATCHES=4 FUZZ_BATCH_INDEX="$batch"')
    expect(workflow).toContain('bash scripts/confine.sh')
    expect(workflow).toContain('fuzz-${shard_file}.test.ts')
  })
})

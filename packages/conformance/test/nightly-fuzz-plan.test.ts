import { attributeExpectedFailure } from '@durablerun/core/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fuzzBatchSeeds } from './fuzz-shard-runner.js'

describe('fuzz shard batch plan', () => {
  it('partitions every nightly seed exactly once into bounded fresh-process batches', async () => {
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-exact-coverage' },
      /expected .* to be less than or equal to 160|expected .* to be 20000|expected .* to deeply equal/,
      async () => {
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
      },
    )
  })

  it('rejects invalid plan dimensions', async () => {
    const valid = { totalSeeds: 64, shard: 0, shardCount: 32, batch: 0, batchCount: 2 }
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-dimensions' },
      /expected function to throw an error/,
      async () => {
        for (const override of [
          { totalSeeds: 0 },
          { totalSeeds: 1.5 },
          { shardCount: 0 },
          { shardCount: 1.5 },
          { batchCount: 0 },
          { batchCount: 1.5 },
        ]) {
          expect(() => fuzzBatchSeeds({ ...valid, ...override })).toThrow(
            /must be a positive integer/,
          )
        }
      },
    )
  })

  it('rejects out-of-range shard and batch coordinates', async () => {
    const valid = { totalSeeds: 64, shard: 0, shardCount: 32, batch: 0, batchCount: 2 }
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-coordinate-range' },
      /expected function to throw an error/,
      async () => {
        for (const override of [{ shard: -1 }, { shard: 32 }, { batch: -1 }, { batch: 2 }]) {
          expect(() => fuzzBatchSeeds({ ...valid, ...override })).toThrow(/must be an integer in/)
        }
      },
    )
  })

  it('rejects an empty process batch', async () => {
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-empty-rejected' },
      /expected function to throw an error/,
      async () => {
        expect(() =>
          fuzzBatchSeeds({
            totalSeeds: 1,
            shard: 1,
            shardCount: 2,
            batch: 0,
            batchCount: 1,
          }),
        ).toThrow(/owns no seeds/)
      },
    )
  })

  it('enrolls every logical shard and bounded batch in the hosted nightly', async () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/nightly.yml', import.meta.url),
      'utf8',
    )
    const shardVector = workflow.match(/shard:\s*\[([^\]]+)\]/)?.[1]
    expect(shardVector).toBeDefined()
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-enrollment' },
      /expected .* to deeply equal/,
      async () =>
        expect(shardVector?.split(',').map((value) => Number(value.trim()))).toEqual(
          Array.from({ length: 32 }, (_, shard) => shard),
        ),
    )
    const fuzzStep = workflow.match(
      /- name: Run bounded nightly fuzz shard(?<step>[\s\S]+?)(?=\n {2}# One TLC process)/,
    )?.groups?.step
    expect(fuzzStep).toBeDefined()
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-batches' },
      /expected .* to contain/,
      async () => {
        expect(fuzzStep).toContain('for batch in 0 1 2 3')
        expect(fuzzStep).toContain('FUZZ_BATCHES=4 FUZZ_BATCH_INDEX="$batch"')
      },
    )
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-confinement' },
      /expected .* to contain/,
      async () => {
        expect(fuzzStep).toContain('bash scripts/confine.sh')
      },
    )
    expect(fuzzStep).toContain('fuzz-${shard_file}.test.ts')
  })
})

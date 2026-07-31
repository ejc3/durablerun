import { attributeExpectedFailure, requireExpectedFailure } from '@durablerun/core/testing'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { fuzzBatchSeeds } from './fuzz-shard-runner.js'

interface HostedFuzzProcess {
  readonly shard: number
  readonly shardCount: number
  readonly batch: number
  readonly batchCount: number
  readonly walks: number
  readonly totalSeeds: number
  readonly steps: number
  readonly command: string
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const NIGHTLY_FUZZ_SCRIPT = fileURLToPath(
  new URL('../../../scripts/nightly-fuzz-shard.sh', import.meta.url),
)

function hostedFuzzPlan(shard: number): readonly HostedFuzzProcess[] {
  const output = execFileSync('bash', [NIGHTLY_FUZZ_SCRIPT, '--plan', String(shard)], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return output
    .trim()
    .split('\n')
    .map((line) => {
      const [ownedShard, shardCount, batch, batchCount, walks, totalSeeds, steps, command] =
        line.split('\t')
      return {
        shard: Number(ownedShard),
        shardCount: Number(shardCount),
        batch: Number(batch),
        batchCount: Number(batchCount),
        walks: Number(walks),
        totalSeeds: Number(totalSeeds),
        steps: Number(steps),
        command: command ?? '',
      }
    })
}

function executedHostedFuzzBatches(shard: number): readonly number[] {
  const directory = mkdtempSync(join(tmpdir(), 'durablerun-nightly-execution-'))
  const executions = join(directory, 'executions')
  try {
    writeFileSync(executions, '')
    writeFileSync(
      join(directory, 'env'),
      `#!/bin/sh
for argument do
  case "$argument" in
    FUZZ_BATCH_INDEX=*)
      printf '%s\\n' "\${argument#FUZZ_BATCH_INDEX=}" >> "$DURABLERUN_NIGHTLY_EXECUTION_PROBE"
      exit 0
      ;;
  esac
done
printf 'missing\\n' >> "$DURABLERUN_NIGHTLY_EXECUTION_PROBE"
`,
      { mode: 0o755 },
    )
    execFileSync('/bin/bash', [NIGHTLY_FUZZ_SCRIPT, String(shard)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DURABLERUN_NIGHTLY_EXECUTION_PROBE: executions,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
      },
    })
    return readFileSync(executions, 'utf8').split('\n').filter(Boolean).map(Number)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

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
    await requireExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-dimensions' },
      (error) =>
        error instanceof RangeError &&
        error.message === 'totalSeeds must be a positive integer, got 1.5',
      async () => {
        void fuzzBatchSeeds({ ...valid, totalSeeds: 1.5 })
      },
    )
    for (const override of [
      { totalSeeds: 0 },
      { shardCount: 0 },
      { shardCount: 1.5 },
      { batchCount: 0 },
      { batchCount: 1.5 },
    ]) {
      expect(() => fuzzBatchSeeds({ ...valid, ...override })).toThrow(/must be a positive integer/)
    }
  })

  it('rejects out-of-range shard and batch coordinates', async () => {
    const valid = { totalSeeds: 64, shard: 0, shardCount: 32, batch: 0, batchCount: 2 }
    await requireExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-coordinate-range' },
      (error) =>
        error instanceof RangeError &&
        error.message === 'shard must be an integer in [0, 32), got 32',
      async () => {
        void fuzzBatchSeeds({ ...valid, shard: valid.shardCount })
      },
    )
    for (const override of [{ shard: -1 }, { batch: -1 }, { batch: valid.batchCount }]) {
      expect(() => fuzzBatchSeeds({ ...valid, ...override })).toThrow(/must be an integer in/)
    }
  })

  it('rejects an empty process batch', async () => {
    await requireExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-plan-empty-rejected' },
      (error) =>
        error instanceof RangeError &&
        error.message === 'fuzz batch 0/1 of shard 1/2 owns no seeds',
      async () => {
        void fuzzBatchSeeds({
          totalSeeds: 1,
          shard: 1,
          shardCount: 2,
          batch: 0,
          batchCount: 1,
        })
      },
    )
  })

  it('enrolls every logical shard and bounded batch in the hosted nightly', async () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/nightly.yml', import.meta.url),
      'utf8',
    )
    const document = parse(workflow) as {
      jobs: {
        fuzz: {
          if?: unknown
          'continue-on-error'?: unknown
          needs: string
          strategy: {
            'fail-fast': boolean
            'max-parallel': number
            matrix: { shard: number[]; exclude?: unknown }
          }
          steps: Array<{ name?: string; env?: Record<string, string>; run?: string }>
        }
        tla: {
          strategy: { matrix: { target: string[] } }
          steps: Array<{ run?: string }>
        }
      }
    }
    const fuzzJob = document.jobs.fuzz
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-enrollment' },
      /expected .* to deeply equal/,
      async () => {
        expect({
          needs: fuzzJob.needs,
          failFast: fuzzJob.strategy['fail-fast'],
          maxParallel: fuzzJob.strategy['max-parallel'],
          shards: fuzzJob.strategy.matrix.shard,
        }).toEqual({
          needs: 'verify',
          failFast: false,
          maxParallel: 8,
          shards: Array.from({ length: 32 }, (_, shard) => shard),
        })
      },
    )
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-if' },
      /expected .* to be undefined/,
      async () => {
        expect(fuzzJob.if).toBeUndefined()
      },
    )
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-continue-on-error' },
      /expected .* to be undefined/,
      async () => {
        expect(fuzzJob['continue-on-error']).toBeUndefined()
      },
    )
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-exclude' },
      /expected .* to be undefined/,
      async () => {
        expect(fuzzJob.strategy.matrix.exclude).toBeUndefined()
      },
    )
    const fuzzStep = fuzzJob.steps.find((step) => step.name === 'Run bounded nightly fuzz shard')
    expect(fuzzStep).toBeDefined()
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-invocation' },
      /expected .* to deeply equal/,
      async () => {
        expect(fuzzStep).toEqual({
          name: 'Run bounded nightly fuzz shard',
          env: { FUZZ_SHARD: '${{ matrix.shard }}' },
          run: 'bash scripts/nightly-fuzz-shard.sh "$FUZZ_SHARD"',
        })
      },
    )
    expect(document.jobs.tla.strategy.matrix.target).toEqual([
      'safety',
      'liveness1',
      'liveness2',
      'liveness3',
      'liveness4',
      'liveness5',
    ])
    expect(document.jobs.tla.steps.at(-1)?.run).toBe(
      'TLA_ONLY=${{ matrix.target }} bash scripts/confine.sh bash scripts/tla.sh',
    )
  })

  it('executes one canonical confined command for every hosted batch', async () => {
    const plans = Array.from({ length: 32 }, (_, shard) => hostedFuzzPlan(shard))
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-batches' },
      /expected .* to deeply equal/,
      async () => {
        for (const [shard, plan] of plans.entries()) {
          expect(
            plan.map(({ batch, batchCount, shard: ownedShard, shardCount }) => ({
              batch,
              batchCount,
              shard: ownedShard,
              shardCount,
            })),
          ).toEqual(
            Array.from({ length: 4 }, (_, batch) => ({
              batch,
              batchCount: 4,
              shard,
              shardCount: 32,
            })),
          )
        }
      },
    )
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-workflow-confinement' },
      /expected .* to contain/,
      async () => {
        for (const plan of plans) {
          for (const process of plan) {
            expect(process.command).toContain(' bash scripts/confine.sh ')
          }
        }
      },
    )
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-runtime-environment' },
      /expected false to be true/,
      async () => {
        for (const plan of plans) {
          for (const process of plan) {
            expect(
              process.command.startsWith(
                `env FUZZ_SEEDS=20000 FUZZ_STEPS=150 FUZZ_BATCHES=4 FUZZ_BATCH_INDEX=${process.batch} `,
              ),
            ).toBe(true)
          }
        }
      },
    )
    for (const [shard, plan] of plans.entries()) {
      expect(plan.reduce((sum, process) => sum + process.walks, 0)).toBe(625)
      for (const process of plan) {
        expect(process.command).toContain(
          `pnpm exec vitest run packages/conformance/test/fuzz-${String(shard).padStart(
            2,
            '0',
          )}.test.ts --maxWorkers=1`,
        )
        expect(process.walks).toBe(
          fuzzBatchSeeds({
            totalSeeds: process.totalSeeds,
            shard: process.shard,
            shardCount: process.shardCount,
            batch: process.batch,
            batchCount: process.batchCount,
          }).length,
        )
        expect(process.steps).toBe(150)
      }
    }
  })

  it('launches every planned batch through the real hosted path', async () => {
    const expected = hostedFuzzPlan(0).map(({ batch }) => batch)
    const executed = executedHostedFuzzBatches(0)
    const mismatch =
      `hosted batch execution mismatch: expected ${JSON.stringify(expected)}, ` +
      `got ${JSON.stringify(executed)}`
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-batch-execution' },
      (error) => error instanceof Error && error.message === mismatch,
      async () => {
        if (
          executed.length !== expected.length ||
          executed.some((batch, index) => batch !== expected[index])
        ) {
          throw new Error(mismatch)
        }
      },
    )
  })

  it('derives every fuzz file coordinate from its filename', async () => {
    const directory = new URL('.', import.meta.url)
    const expected = Array.from(
      { length: 32 },
      (_, shard) => `fuzz-${String(shard).padStart(2, '0')}.test.ts`,
    )
    const files = readdirSync(directory)
      .filter((file) => /^fuzz-\d{2}\.test\.ts$/.test(file))
      .toSorted()
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'nightly-fuzz-file-enrollment' },
      /expected .* to be/,
      async () => {
        expect(files).toEqual(expected)
        for (const [shard, file] of files.entries()) {
          expect(readFileSync(new URL(file, directory), 'utf8')).toBe(
            `import { runFuzzShard } from './fuzz-shard-runner.js'\n\nrunFuzzShard(${shard}, 32)\n`,
          )
        }
      },
    )
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DogfoodConfig } from '../src/config.js'
import type { RefObservation } from '../src/ref-journal.js'
import { DogfoodRuntime } from '../src/runtime.js'
import { describe, expect, it, vi } from 'vitest'

function snapshot(serial: number): RefObservation {
  return {
    repository: 'ejc3/durablerun',
    ref: 'main',
    commitSha: `commit-${serial}`,
    treeSha: `tree-${serial}`,
    committedAt: '2026-08-29T00:00:00Z',
  }
}

function config(databaseUrl: string, idempotencyKey: string, cycles: number): DogfoodConfig {
  return {
    databaseUrl,
    queue: 'dogfood',
    idempotencyKey,
    repository: 'ejc3/durablerun',
    ref: 'main',
    cycles,
    intervalSeconds: 0,
    leaseSeconds: 30,
    fault: 'none',
  }
}

describe('dogfood milestone receipts', () => {
  it('reports every checkpoint past ordinal ten with auditable contiguous ownership', async () => {
    let calls = 0
    const runtime = await DogfoodRuntime.open(config(':memory:', 'twelve', 12), {
      observe: async () => snapshot(++calls),
    })
    try {
      await runtime.start()
      for (let i = 0; i < 12; i++) await runtime.tick()
      const status = await runtime.status()
      expect(status).toMatchObject({
        found: true,
        expectedCheckpointCount: 12,
        observedCheckpointCount: 12,
        contiguousCheckpointCount: 12,
        checkpointSpanMs: expect.any(Number),
      })
      const receipt = status as unknown as {
        refObservations: Array<Record<string, unknown>>
      }
      expect(receipt.refObservations).toHaveLength(12)
      expect(receipt.refObservations[9]).toMatchObject({
        ordinal: 10,
        key: 'observe-ref#10',
        ownerAttempt: 1,
        snapshot: { commitSha: 'commit-10' },
      })
      expect(receipt.refObservations[9]).toHaveProperty('observedAtEpochMs')
      expect(receipt.refObservations[9]).toHaveProperty('ownerRunId')
    } finally {
      runtime.close()
    }
  })

  it('reopens a file-backed journal and replays committed observations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'durablerun-dogfood-reopen-'))
    const cfg = config(`file:${join(directory, 'journal.db')}`, 'reopen', 2)
    const firstSnapshot = vi.fn(async () => snapshot(1))
    const first = await DogfoodRuntime.open(cfg, { observe: firstSnapshot })
    try {
      await first.start()
      await first.tick()
    } finally {
      first.close()
    }
    const secondSnapshot = vi.fn(async () => snapshot(2))
    const second = await DogfoodRuntime.open(cfg, { observe: secondSnapshot })
    try {
      await second.tick()
      await expect(second.status()).resolves.toMatchObject({
        found: true,
        state: 'completed',
        observedCheckpointCount: 2,
        contiguousCheckpointCount: 2,
      })
      expect(firstSnapshot).toHaveBeenCalledTimes(1)
      expect(secondSnapshot).toHaveBeenCalledTimes(1)
    } finally {
      second.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['driver-before-activation', 'worker-after-checkpoint'] as const)(
    'places the %s hard-exit hook at the intended actor boundary',
    async (fault) => {
      const exit = new Error('hard exit')
      const hardExit = vi.fn((): never => {
        throw exit
      })
      const runtime = await DogfoodRuntime.open(config(':memory:', fault, 1), {
        observe: async () => snapshot(1),
        fault,
        hardExit,
      })
      try {
        await runtime.start()
        await runtime.tick()
        expect(hardExit).toHaveBeenCalledOnce()
        if (fault === 'worker-after-checkpoint') {
          await expect(runtime.status()).resolves.toMatchObject({ observedCheckpointCount: 1 })
        }
      } finally {
        runtime.close()
      }
    },
  )
})

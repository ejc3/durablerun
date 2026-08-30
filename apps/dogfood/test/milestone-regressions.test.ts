import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testIdSource } from '@durablerun/store-libsql/testing'
import { describe, expect, it, vi } from 'vitest'
import { type DogfoodConfig, dogfoodConfigFromEnv } from '../src/config.js'
import type { RefObservation } from '../src/ref-journal.js'
import { DogfoodRuntime } from '../src/runtime.js'

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
  it('isolates a deliberate-death probe from due normal work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'durablerun-dogfood-fault-isolation-'))
    const databaseUrl = `file:${join(directory, 'journal.db')}`
    const normalConfig = dogfoodConfigFromEnv({
      TURSO_DATABASE_URL: databaseUrl,
      DURABLERUN_DOGFOOD_CYCLES: '1',
      DURABLERUN_DOGFOOD_INTERVAL_SECONDS: '0',
    })
    const normal = await DogfoodRuntime.open(normalConfig, { ids: testIdSource('a-normal') })
    try {
      await normal.start()
    } finally {
      normal.close()
    }

    const faultConfig = dogfoodConfigFromEnv({
      TURSO_DATABASE_URL: databaseUrl,
      DURABLERUN_DOGFOOD_KEY: 'fresh-probe',
      DURABLERUN_DOGFOOD_CYCLES: '1',
      DURABLERUN_DOGFOOD_INTERVAL_SECONDS: '0',
      DURABLERUN_DOGFOOD_LEASE_SECONDS: '1',
      DURABLERUN_DOGFOOD_PROBE: 'true',
      DURABLERUN_DOGFOOD_FAULT: 'driver-before-activation',
    })
    const hardExit = vi.fn((): never => {
      throw new Error('hard exit')
    })
    const fault = await DogfoodRuntime.open(faultConfig, {
      ids: testIdSource('z-fault'),
      hardExit,
    })
    try {
      await fault.start()
      await fault.tick().catch(() => undefined)
      expect(hardExit).toHaveBeenCalledOnce()
      await expect(fault.status()).resolves.toMatchObject({ found: true, state: 'running' })
    } finally {
      fault.close()
    }

    const normalStatus = await DogfoodRuntime.open(normalConfig)
    try {
      await expect(normalStatus.status()).resolves.toMatchObject({ found: true, state: 'pending' })
    } finally {
      normalStatus.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'repository target',
      { repository: 'wrong-owner/wrong-repo', ref: 'release', cycles: 15, intervalSeconds: 43_200 },
    ],
    [
      'journal cadence',
      {
        repository: 'ejc3/durablerun',
        ref: 'main',
        cycles: 2,
        intervalSeconds: 31_536_000,
      },
    ],
  ] as const)(
    'rejects an idempotently reused task with a different durable %s',
    async (_name, seededParameters) => {
      const directory = mkdtempSync(join(tmpdir(), 'durablerun-dogfood-workload-binding-'))
      const databaseUrl = `file:${join(directory, 'journal.db')}`
      const desired: DogfoodConfig = {
        databaseUrl,
        queue: 'dogfood',
        idempotencyKey: 'reused-journal',
        repository: 'ejc3/durablerun',
        ref: 'main',
        cycles: 15,
        intervalSeconds: 43_200,
        leaseSeconds: 30,
        fault: 'none',
      }
      const seeded = await DogfoodRuntime.open({ ...desired, ...seededParameters })
      try {
        await seeded.start()
      } finally {
        seeded.close()
      }

      const reopened = await DogfoodRuntime.open(desired)
      try {
        const error = await reopened.start().then(
          () => null,
          (reason: unknown) => reason,
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toContain('durable journal workload does not match configured intent')
      } finally {
        reopened.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

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
        durableParameters: { cycles: 12, intervalSeconds: 0 },
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
      const faultConfig = dogfoodConfigFromEnv({
        TURSO_DATABASE_URL: ':memory:',
        DURABLERUN_DOGFOOD_KEY: fault,
        DURABLERUN_DOGFOOD_CYCLES: '1',
        DURABLERUN_DOGFOOD_INTERVAL_SECONDS: '0',
        DURABLERUN_DOGFOOD_PROBE: 'true',
        DURABLERUN_DOGFOOD_FAULT: fault,
      })
      const runtime = await DogfoodRuntime.open(faultConfig, {
        observe: async () => snapshot(1),
        hardExit,
      })
      try {
        await runtime.start()
        await runtime.tick().catch(() => undefined)
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

import type { DogfoodConfig } from '../src/config.js'
import type { RefObservation } from '../src/ref-journal.js'
import { DogfoodRuntime } from '../src/runtime.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

const config: DogfoodConfig = {
  databaseUrl: ':memory:',
  queue: 'dogfood',
  idempotencyKey: 'health-test',
  repository: 'ejc3/durablerun',
  ref: 'main',
  cycles: 2,
  intervalSeconds: 0,
  leaseSeconds: 30,
  fault: 'none',
}

const open: DogfoodRuntime[] = []

afterEach(() => {
  for (const runtime of open.splice(0)) runtime.close()
})

describe('ref-journal dogfood runtime', () => {
  it('starts idempotently and reports a missing or pending task', async () => {
    const missing = await DogfoodRuntime.open(config)
    open.push(missing)
    await expect(missing.status()).resolves.toEqual({
      found: false,
      queue: 'dogfood',
      idempotencyKey: 'health-test',
    })

    const first = await missing.start()
    const second = await missing.start()
    expect(first.created).toBe(true)
    expect(second).toMatchObject({ created: false, taskId: first.taskId })
    await expect(missing.status()).resolves.toMatchObject({
      found: true,
      taskId: first.taskId,
      state: 'pending',
      refObservations: [],
    })
  })

  it('runs one inline pass per tick, replays checkpoints, and exits completed', async () => {
    const seen: string[] = []
    const snapshot = vi.fn(async (repository: string, ref: string): Promise<RefObservation> => {
      const serial = seen.push(`${repository}@${ref}`)
      return {
        repository,
        ref,
        commitSha: `commit-${serial}`,
        treeSha: `tree-${serial}`,
        committedAt: `2026-08-${String(28 + serial).padStart(2, '0')}T00:00:00Z`,
      }
    })
    const runtime = await DogfoodRuntime.open(config, { observe: snapshot })
    open.push(runtime)
    await runtime.start()

    await expect(runtime.tick()).resolves.toMatchObject({ claimed: 1, ended: 1 })
    await expect(runtime.status()).resolves.toMatchObject({
      found: true,
      state: 'pending',
      refObservations: [{ snapshot: { commitSha: 'commit-1' } }],
    })

    await expect(runtime.tick()).resolves.toMatchObject({ claimed: 1, ended: 1 })
    const status = await runtime.status()
    expect(status).toMatchObject({
      found: true,
      state: 'completed',
      attempts: 0,
      infraRetries: 0,
      refObservations: [
        { snapshot: { commitSha: 'commit-1' } },
        { snapshot: { commitSha: 'commit-2' } },
      ],
      completedResult: { cycles: 2 },
    })
    expect(snapshot).toHaveBeenCalledTimes(2)

    await expect(runtime.tick()).resolves.toMatchObject({ claimed: 0, ended: 0 })
    expect(snapshot).toHaveBeenCalledTimes(2)
  })
})

import { LeaseLostError } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runClaimedRun, type TaskRegistry } from '../src/index.js'

const Q = 'q'
class InstantClock {
  now = 1_000_000
  nowEpochMs() {
    return this.now
  }
  yieldTurn(): Promise<void> {
    return new Promise((r) => setImmediate(r))
  }
  sleep(_ms: number, interrupt?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (interrupt?.aborted) return resolve()
      interrupt?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
}
async function fx(seed: string) {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new InstantClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.now += ms
    await admin.setFakeNowEpochMs(clock.now)
  }
  return { raw, admin, ids, store, clock, advance, close: () => raw.close() }
}
async function pass(f: Awaited<ReturnType<typeof fx>>, reg: TaskRegistry, token: string) {
  const [run] = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('claim')
  return runClaimedRun(
    { store: f.store, clock: f.clock, registry: reg },
    { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
  )
}

/** Events review regressions — each failed against the round as shipped. */
describe('event regressions', () => {
  it('re-await after a timeout WAITS AGAIN and receives a late emit', async () => {
    const f = await fx('ev-reawait')
    const trace: string[] = []
    const reg: TaskRegistry = new Map([
      [
        'retrier',
        async (ctx) => {
          for (let i = 0; i < 3; i++) {
            try {
              const p = await ctx.awaitEvent('go', { timeoutSeconds: 30 })
              trace.push(`got:${p}`)
              return trace
            } catch {
              trace.push('timeout')
            }
          }
          trace.push('gave-up')
          return trace
        },
      ],
    ])
    const spawned = await f.store.spawn(Q, 'retrier', '{}')
    expect(await pass(f, reg, 'w1')).toEqual({ kind: 'suspended' })
    await f.advance(31_000) // first timeout fires
    expect(await pass(f, reg, 'w2')).toEqual({ kind: 'suspended' }) // MUST re-park
    await f.store.emitEvent(Q, 'go', '{"late":1}')
    expect(await pass(f, reg, 'w3')).toEqual({ kind: 'completed' })
    const result = await f.store.getTaskResult(Q, spawned.taskId)
    expect(JSON.parse(result?.completedPayloadJson ?? '[]')).toEqual(['timeout', 'got:{"late":1}'])
    f.close()
  })

  it('a zombie awaitEvent HIT is fence-refused, never a success signal', async () => {
    const f = await fx('ev-zombie-hit')
    await f.store.spawn(Q, 'z', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.expireLeaseNow(Q, run.runId, run.claimToken)
    await f.advance(1)
    await f.store.sweep(Q, 10)
    await f.store.emitEvent(Q, 'e', '{"n":1}')
    await expect(
      f.store.awaitEvent(Q, run.taskId, run.runId, run.claimToken, 's', 'e', null),
    ).rejects.toThrow(LeaseLostError)
    f.close()
  })

  it('a foreign task_id cannot register a wait under a valid lease', async () => {
    const f = await fx('ev-foreign')
    await f.store.spawn(Q, 'a', '{}')
    const other = await f.store.spawn(Q, 'b', '{}', { startDelaySeconds: 900 })
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await expect(
      f.store.awaitEvent(Q, other.taskId, run.runId, run.claimToken, 's', 'e', null),
    ).rejects.toThrow(LeaseLostError)
    const [w] = await f.raw.batch('t', [{ sql: `SELECT COUNT(*) AS n FROM waits`, args: [] }])
    expect(Number(w?.rows[0]?.n)).toBe(0)
    f.close()
  })

  it("event names with '#' or a '$' prefix are refused (replay-key injectivity)", async () => {
    const f = await fx('ev-charset')
    const reg: TaskRegistry = new Map([
      ['bad', async (ctx) => ctx.awaitEvent('go#2')],
      ['bad2', async (ctx) => ctx.awaitEvent('$go')],
    ])
    const a = await f.store.spawn(Q, 'bad', '{}', { maxAttempts: 1 })
    expect(await pass(f, reg, 'w1')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, a.taskId))?.state).toBe('failed')
    const b = await f.store.spawn(Q, 'bad2', '{}', { maxAttempts: 1 })
    expect(await pass(f, reg, 'w2')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, b.taskId))?.state).toBe('failed')
    f.close()
  })

  it('an invalid awaitEvent timeout is a PERMANENT user error', async () => {
    const f = await fx('ev-bad-timeout')
    const reg: TaskRegistry = new Map([
      ['bad', async (ctx) => ctx.awaitEvent('go', { timeoutSeconds: Number.NaN })],
    ])
    const a = await f.store.spawn(Q, 'bad', '{}', { maxAttempts: 3 })
    expect(await pass(f, reg, 'w1')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, a.taskId))?.state).toBe('failed')
    f.close()
  })
})

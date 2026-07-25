import { EventTimeoutError, LeaseLostError } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { type TaskRegistry, runClaimedRun } from '../src/index.js'

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
  const { raw, admin } = await openTestDb()
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
            } catch (e) {
              // The realistic retry pattern: catch the TIMEOUT, let the
              // engine's suspend signal pass through (a bare catch that
              // swallows it de-syncs the pass from its own parked run).
              if (!(e instanceof EventTimeoutError)) throw e
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
    // Two 'timeout' entries: the wake pass pushed one, and the final pass
    // REPLAYED the memoized timeout (non-step code re-executes by design;
    // only the awaits themselves are memoized) before receiving the emit.
    expect(JSON.parse(result?.completedPayloadJson ?? '[]')).toEqual([
      'timeout',
      'timeout',
      'got:{"late":1}',
    ])
    f.close()
  })

  it('two same-name timed awaits that BOTH time out complete, never re-parking forever', async () => {
    // Codex PR#11 finding 1: the carried wake matches by event NAME, which
    // is not unique across awaits. When the SECOND await('go') times out,
    // replaying the FIRST await's memo consumes the second's wake, so the
    // second re-parks — forever. Bind the wake to the step key instead.
    const f = await fx('ev-double-timeout')
    const trace: string[] = []
    const reg: TaskRegistry = new Map([
      [
        'twice',
        async (ctx) => {
          for (let i = 0; i < 2; i++) {
            try {
              await ctx.awaitEvent('go', { timeoutSeconds: 30 })
              trace.push('got')
            } catch (e) {
              if (!(e instanceof EventTimeoutError)) throw e
              trace.push('timeout')
            }
          }
          trace.push('done')
          return trace
        },
      ],
    ])
    const spawned = await f.store.spawn(Q, 'twice', '{}')
    // Drive passes, firing each timeout; the run must terminate. With the
    // bug the second await re-parks on every timer fire and never completes.
    let completed = false
    for (let round = 0; round < 8 && !completed; round++) {
      const outcome = await pass(f, reg, `w${round}`)
      completed = outcome.kind === 'completed'
      await f.advance(31_000)
    }
    expect(completed).toBe(true)
    expect((await f.store.getTaskResult(Q, spawned.taskId))?.state).toBe('completed')
    f.close()
  })

  // fenceTwin('AwaitEventHit') — the already-emitted read path: the model
  // fences AwaitEventHit, so a swept zombie gets the lease error, never the
  // payload (this guard shipped without its twin once; the twin is now
  // ledger-enforced per fenced ACTION).
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

/**
 * The user boundary has validators for NAMES and for KNOBS. A VALUE had no
 * home, so the one user input that is neither — an event payload — reached
 * the database driver unchecked.
 */
describe('user-boundary values', () => {
  it('a payload that is not a string fails the task permanently, not as an outage', async () => {
    const f = await fx('emit-unserializable')
    let bodyRuns = 0
    const reg: TaskRegistry = new Map([
      [
        'emitter',
        async (ctx) => {
          bodyRuns++
          // The ordinary typo: a property that does not exist. JSON.stringify
          // is typed `(value: any) => string` but returns undefined for
          // undefined, functions and symbols, so this type-checks cleanly.
          const missing: { v?: object } = {}
          await ctx.emitEvent('go', JSON.stringify(missing.v))
          return 'unreachable'
        },
      ],
    ])
    await f.store.spawn(Q, 'emitter', '{}')

    const outcome = await pass(f, reg, 'w1')

    // Wrong outcome today: the driver rejects the undefined bind, the store
    // wraps every driver throw as an outage, and the worker classifies an
    // outage as 'aborted' — so the user's budget is untouched, the lease is
    // left to expire, and the sweep replaces the run with an infrastructure
    // successor. The handler body then re-runs on every one of those, up to
    // the infrastructure cap, and the task finally dies reporting exhausted
    // infrastructure with no user-visible reason at all.
    expect(outcome.kind).toBe('failed')

    // And a permanent failure means the body does not run again.
    await f.advance(120_000)
    await f.store.sweep(Q, 10)
    expect(bodyRuns).toBe(1)
    f.close()
  })
})

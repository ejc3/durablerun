import { type SchedulerStore, StoreUnavailableError } from '@durablerun/core'
import { engineInvariantViolations } from '@durablerun/conformance'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runClaimedRun, type TaskRegistry } from '../src/index.js'

const Q = 'q'

class InstantClock {
  now = 1_000_000
  nowEpochMs(): number {
    return this.now
  }
  yieldTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }
  sleep(_ms: number, interrupt?: AbortSignal): Promise<void> {
    // The pump parks here until the pass ends (its stop signal aborts us);
    // passes in this suite finish fast, so time itself never advances.
    return new Promise((resolve) => {
      if (interrupt?.aborted) {
        resolve()
        return
      }
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

async function claimAndRun(
  f: Awaited<ReturnType<typeof fx>>,
  store: SchedulerStore,
  reg: TaskRegistry,
  token: string,
) {
  const [run] = await store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('expected a claimable run')
  return runClaimedRun(
    { store, clock: f.clock, registry: reg },
    { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
  )
}

/**
 * Review regressions (red/green rule): each test failed against the SDK as
 * first committed; the finding it pins is named in the title.
 */
describe('SDK review regressions', () => {
  it('a botched suspension cannot fake the wake: the sleep marker and the park are one transition', async () => {
    const f = await fx('sdk-atomic-suspend')
    // The suspension write fails once (store blip at exactly the wrong
    // moment). With a NON-atomic suspend (marker committed in one batch,
    // park in a second), this leaves a lying marker: the run never parked,
    // the lease expires, the infra successor preloads the marker, and a
    // ONE-HOUR sleep completes in seconds.
    let failParkOnce = true
    const flaky = new Proxy(f.store, {
      get(target, prop, receiver) {
        const real = Reflect.get(target, prop, receiver)
        if ((prop === 'reschedule' || prop === 'suspendRun') && failParkOnce) {
          return (...args: unknown[]) => {
            failParkOnce = false
            return Promise.reject(new Error('store blip'))
          }
        }
        return typeof real === 'function' ? (real as CallableFunction).bind(target) : real
      },
    })
    const passes: number[] = []
    const reg: TaskRegistry = new Map([
      [
        'napper',
        async (ctx) => {
          passes.push(1)
          await ctx.sleepFor(3600) // one hour
          return 'woke'
        },
      ],
    ])
    const spawned = await f.store.spawn(Q, 'napper', '{}')
    await claimAndRun(f, flaky as SchedulerStore, reg, 'w1').catch(() => {})

    // The lease expires; the sweep makes an infra successor; a worker runs it.
    await f.advance(61_000)
    await f.store.sweep(Q, 10)
    await f.advance(6_000) // past the infra backoff
    await claimAndRun(f, f.store, reg, 'w2').catch(() => {})

    // Only ~67 seconds have passed of a 3600-second sleep: the task must
    // NOT be complete — the successor pass must have suspended again.
    const result = await f.store.getTaskResult(Q, spawned.taskId)
    expect(result?.state).not.toBe('completed')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it("a store outage during complete() never spends the user's retry budget", async () => {
    const f = await fx('sdk-complete-outage')
    let failComplete = true
    const flaky = new Proxy(f.store, {
      get(target, prop, receiver) {
        const real = Reflect.get(target, prop, receiver)
        if (prop === 'complete' && failComplete) {
          return () => {
            failComplete = false
            return Promise.reject(new StoreUnavailableError('ECONNRESET (transient)'))
          }
        }
        return typeof real === 'function' ? (real as CallableFunction).bind(target) : real
      },
    })
    const reg: TaskRegistry = new Map([['job', async () => 'succeeded']])
    // ONE user attempt: if the outage is misbilled as a user failure, the
    // task — whose handler SUCCEEDED — terminally fails.
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
    await claimAndRun(f, flaky as SchedulerStore, reg, 'w1').catch(() => {})

    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(0) // infra, never user
    expect(task?.rows[0]?.state).not.toBe('failed')
    // Recovery is the lease story: sweep, infra successor, second pass wins.
    await f.advance(61_000)
    await f.store.sweep(Q, 10)
    await f.advance(6_000)
    await claimAndRun(f, f.store, reg, 'w2')
    expect((await f.store.getTaskResult(Q, spawned.taskId))?.state).toBe('completed')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it("a store outage inside a step never spends the user's retry budget either", async () => {
    const f = await fx('sdk-step-outage')
    let failCheckpoint = true
    const flaky = new Proxy(f.store, {
      get(target, prop, receiver) {
        const real = Reflect.get(target, prop, receiver)
        if (prop === 'setCheckpoint' && failCheckpoint) {
          return () => {
            failCheckpoint = false
            return Promise.reject(new StoreUnavailableError('SQLITE_BUSY (transient)'))
          }
        }
        return typeof real === 'function' ? (real as CallableFunction).bind(target) : real
      },
    })
    const reg: TaskRegistry = new Map([['job', async (ctx) => ctx.step('work', () => 'done')]])
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
    await claimAndRun(f, flaky as SchedulerStore, reg, 'w1').catch(() => {})
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(0)
    expect(task?.rows[0]?.state).not.toBe('failed')
    f.close()
  })

  it("step names may not use the reserved characters ('#', leading '$')", async () => {
    const f = await fx('sdk-name-charset')
    // 'poll#2' as a LITERAL name collides with the derived key of the
    // second 'poll' call: the wrong checkpoint would replay silently.
    const reg: TaskRegistry = new Map([
      [
        'job',
        async (ctx) => {
          await ctx.step('poll#2', () => 'literal')
          return 'never'
        },
      ],
      [
        'job2',
        async (ctx) => {
          await ctx.step('$sneaky', () => 'reserved prefix')
          return 'never'
        },
      ],
    ])
    const a = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
    expect(await claimAndRun(f, f.store, reg, 'w1')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, a.taskId))?.state).toBe('failed')
    const b = await f.store.spawn(Q, 'job2', '{}', { maxAttempts: 1 })
    expect(await claimAndRun(f, f.store, reg, 'w2')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, b.taskId))?.state).toBe('failed')
    f.close()
  })
})

describe('SDK residual review regressions', () => {
  it('nested ctx.step calls are refused (they corrupt repeat counters on replay)', async () => {
    const f = await fx('sdk-reentrant')
    const reg: TaskRegistry = new Map([
      [
        'job',
        async (ctx) => {
          // The inner call consumes a counter slot the replaying pass never
          // sees; a later same-named step then replays the WRONG checkpoint.
          await ctx.step('outer', () => ctx.step('x', () => 'A'))
          return ctx.step('x', () => 'B')
        },
      ],
    ])
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
    expect(await claimAndRun(f, f.store, reg, 'w1')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, spawned.taskId))?.state).toBe('failed')
    f.close()
  })

  it('a suspension marker never downgrades a newer attempt (last writer wins)', async () => {
    const f = await fx('sdk-suspend-lww')
    await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    // A NEWER attempt's marker already exists (crafted): the stale attempt's
    // suspension must not overwrite it — same rule setCheckpoint enforces.
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
              VALUES (?, '$sleep', ?, '{"inSeconds":999}', 'newer-run', 5, 1000000)`,
        args: [run.taskId, Q],
      },
    ])
    await f.store
      .suspendRun(
        Q,
        run.runId,
        run.claimToken,
        { inSeconds: 10 },
        {
          key: '$sleep',
          stateJson: '{"inSeconds":10}',
        },
      )
      .catch(() => {})
    const [row] = await f.raw.batch('t', [
      { sql: `SELECT owner_attempt FROM checkpoints WHERE checkpoint_name = '$sleep'`, args: [] },
    ])
    expect(Number(row?.rows[0]?.owner_attempt)).toBe(5)
    f.close()
  })

  it('an invalid sleep duration is a permanent user error, never an infrastructure loop', async () => {
    const f = await fx('sdk-bad-sleep')
    const reg: TaskRegistry = new Map([['job', async (ctx) => ctx.sleepFor(Number.NaN)]])
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
    // Before the fix: SuspendSignal thrown first, validation exploded later
    // inside the park, the run stayed active, and lease recovery repeated
    // the deterministic bad call toward the infrastructure cap.
    expect(await claimAndRun(f, f.store, reg, 'w1')).toEqual({ kind: 'failed' })
    expect((await f.store.getTaskResult(Q, spawned.taskId))?.state).toBe('failed')
    f.close()
  })
})

import { engineInvariantViolations } from '@durablerun/conformance'
import { type Clock, type SchedulerStore, StoreUnavailableError } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { type TaskHandler, type TaskRegistry, runClaimedRun } from '../src/index.js'

const Q = 'q'

/** Instant clock: the pump parks on sleeps we never fire — fine for passes
 * that finish fast; the heartbeat test drives it manually. */
class FakeClock implements Clock {
  now = 1_000_000
  fired: { deadline: number; resolve: () => void }[] = []
  nowEpochMs(): number {
    return this.now
  }
  yieldTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }
  sleep(ms: number, interrupt?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (interrupt?.aborted || ms <= 0) {
        resolve()
        return
      }
      const entry = { deadline: this.now + ms, resolve }
      this.fired.push(entry)
      interrupt?.addEventListener(
        'abort',
        () => {
          this.fired = this.fired.filter((s) => s !== entry)
          resolve()
        },
        { once: true },
      )
    })
  }
  advance(ms: number): void {
    this.now += ms
    const due = this.fired.filter((s) => s.deadline <= this.now)
    this.fired = this.fired.filter((s) => s.deadline > this.now)
    for (const s of due) s.resolve()
  }
}

async function fx(seed: string) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.now += ms
    await admin.setFakeNowEpochMs(clock.now)
    clock.advance(0)
  }
  return { raw, admin, ids, store, clock, advance, close: () => raw.close() }
}

function registry(entries: Record<string, TaskHandler>): TaskRegistry {
  return new Map(Object.entries(entries))
}

async function claimAndRun(
  f: Awaited<ReturnType<typeof fx>>,
  reg: TaskRegistry,
  token: string,
): Promise<ReturnType<typeof runClaimedRun>> {
  const [run] = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('expected a claimable run')
  return runClaimedRun(
    { store: f.store, clock: f.clock, registry: reg },
    { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
  )
}

describe('runClaimedRun', () => {
  it('steps execute exactly once across suspend/resume; the sleep replays as a no-op', async () => {
    const f = await fx('sdk-replay')
    const executions: string[] = []
    const reg = registry({
      job: async (ctx) => {
        const a = await ctx.step('fetch', () => {
          executions.push('fetch')
          return { rows: 3 }
        })
        await ctx.sleepFor(10)
        const b = await ctx.step('write', () => {
          executions.push('write')
          return a.rows * 2
        })
        return { total: b }
      },
    })
    const spawned = await f.store.spawn(Q, 'job', '{}')

    // Pass 1: fetch runs, the sleep suspends the run.
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'suspended' })
    expect(executions).toEqual(['fetch'])

    // Wake and pass 2: fetch REPLAYS (no execution), sleep no-ops, write runs.
    await f.advance(10_000)
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'completed' })
    expect(executions).toEqual(['fetch', 'write'])

    const result = await f.store.getTaskResult(Q, spawned.taskId)
    expect(result?.state).toBe('completed')
    expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toEqual({ total: 6 })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a loop over one step name gets distinct checkpoints (name, name#2, ...)', async () => {
    const f = await fx('sdk-repeat')
    let executed = 0
    const reg = registry({
      job: async (ctx) => {
        const out: number[] = []
        for (let i = 0; i < 3; i++) {
          out.push(
            await ctx.step('poll', () => {
              executed++
              return i * 10
            }),
          )
        }
        return out
      },
    })
    await f.store.spawn(Q, 'job', '{}')
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'completed' })
    expect(executed).toBe(3)
    const [rows] = await f.raw.batch('t', [
      { sql: `SELECT checkpoint_name FROM checkpoints ORDER BY checkpoint_name`, args: [] },
    ])
    expect(rows?.rows.map((r) => r.checkpoint_name)).toEqual(['poll', 'poll#2', 'poll#3'])
    f.close()
  })

  it('a user failure retries with core arithmetic; a completed step never re-executes', async () => {
    const f = await fx('sdk-retry')
    let stepRuns = 0
    let attempts = 0
    const reg = registry({
      job: async (ctx) => {
        await ctx.step('setup', () => {
          stepRuns++
          return 'ready'
        })
        attempts++
        if (attempts === 1) throw new Error('flaky downstream')
        return 'ok'
      },
    })
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'retry-scheduled' })

    // The retry is a fresh run after the backoff; setup must replay.
    await f.advance(10_000)
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'completed' })
    expect(stepRuns).toBe(1)
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]).toMatchObject({ state: 'completed', attempts: 1 })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('FatalTaskError skips remaining retries and fails terminally', async () => {
    const f = await fx('sdk-fatal')
    const { FatalTaskError } = await import('@durablerun/core')
    const reg = registry({
      job: async () => {
        throw new FatalTaskError('unrecoverable input')
      },
    })
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'failed' })
    const result = await f.store.getTaskResult(Q, spawned.taskId)
    expect(result?.state).toBe('failed')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a failing step commits nothing: the next attempt re-executes it', async () => {
    const f = await fx('sdk-step-fail')
    let tries = 0
    const reg = registry({
      job: async (ctx) => {
        return ctx.step('volatile', () => {
          tries++
          if (tries === 1) throw new Error('boom')
          return 'second try'
        })
      },
    })
    await f.store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'retry-scheduled' })
    await f.advance(10_000)
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'completed' })
    expect(tries).toBe(2)
    f.close()
  })

  it('a durable op inside a step fails the task permanently, never suspending mid-step', async () => {
    // Codex PR#11 finding 4: awaitEvent/sleep inside a step body runs while
    // inStep is true, advancing the repeat counters a replaying pass (which
    // skips the memoized step) never sees — the wrong wake is later
    // consumed. A durable op nested in a step is a program bug: fail fast
    // and permanently, don't park a half-executed step.
    const f = await fx('sdk-durable-in-step')
    const reg = registry({
      job: (ctx) => ctx.step('outer', () => ctx.awaitEvent('go', { timeoutSeconds: 30 })),
    })
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'failed' })
    const result = await f.store.getTaskResult(Q, spawned.taskId)
    expect(result?.state).toBe('failed')
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(1) // permanent, not a retry loop
    f.close()
  })

  it('an unknown task name is deferred untouched, and runs on a build that knows it', async () => {
    const f = await fx('sdk-defer')
    const spawned = await f.store.spawn(Q, 'new-task', '{}')
    expect(await claimAndRun(f, registry({}), 'old-build')).toEqual({ kind: 'deferred' })
    // Nothing consumed: no attempt moved, no checkpoint written.
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT attempts, state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]).toMatchObject({ attempts: 0, state: 'sleeping' })
    // A newer build picks it up after the defer window.
    await f.advance(30_000)
    const reg = registry({ 'new-task': async () => 'done' })
    expect(await claimAndRun(f, reg, 'new-build')).toEqual({ kind: 'completed' })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a duplicate delivery of the same claim does nothing', async () => {
    const f = await fx('sdk-dup')
    const reg = registry({ job: async () => 'once' })
    await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    const invocation = {
      queue: Q,
      runId: run.runId,
      claimToken: run.claimToken,
      claimGen: run.claimGen,
    }
    const deps = { store: f.store, clock: f.clock, registry: reg }
    expect(await runClaimedRun(deps, invocation)).toEqual({ kind: 'completed' })
    expect(await runClaimedRun(deps, invocation)).toEqual({ kind: 'superseded' })
    f.close()
  })

  it('losing the lease mid-pass aborts quietly with no transition', async () => {
    const f = await fx('sdk-lease-lost')
    const reg = registry({
      job: async (ctx) => {
        await ctx.step('first', () => 'ok')
        // The lease vanishes while user code is between steps.
        await f.store.expireLeaseNow(Q, currentRun.runId, currentRun.claimToken)
        await f.advance(1) // sweep sees it expired
        await f.store.sweep(Q, 10)
        return ctx.step('second', () => 'never committed')
      },
    })
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    const currentRun = run
    const outcome = await runClaimedRun(
      { store: f.store, clock: f.clock, registry: reg },
      { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
    )
    expect(outcome).toEqual({ kind: 'lease-lost' })
    // The sweep owns recovery; the zombie committed nothing after the loss.
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]?.state).not.toBe('completed')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a store outage during the failure write aborts cleanly, like every other transition', async () => {
    // Every transition write (complete, suspend, fail, the rolling-deploy
    // defer) classifies a StoreUnavailableError the same way: no transition
    // committed, the lease story recovers, the user's budget is untouched —
    // {kind:'aborted'}. Two of the five catch sites used to drop that arm
    // and rethrow raw, so a store blip during a user-failure write surfaced
    // as an unexpected crash instead of a clean abort.
    const f = await fx('sdk-fail-outage')
    const failing = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'fail') {
          return () => Promise.reject(new StoreUnavailableError('outage during fail'))
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const reg = registry({
      job: () => {
        throw new Error('user failure that must be recorded as a fail()')
      },
    })
    await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    const outcome = await runClaimedRun(
      { store: failing as SchedulerStore, clock: f.clock, registry: reg },
      { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
    f.close()
  })

  it('the heartbeat pump keeps a long pass alive at half-lease cadence', async () => {
    const f = await fx('sdk-pump')
    let beats = 0
    const counting = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'heartbeat') {
          beats++
          return Reflect.get(target, prop, receiver).bind(target)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const reg = registry({
      job: async () => {
        // A slow external call: 90s against a 60s lease. Only the pump
        // keeps the sweep away.
        await f.clock.sleep(90_000)
        return 'survived'
      },
    })
    await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    const pass = runClaimedRun(
      { store: counting as SchedulerStore, clock: f.clock, registry: reg },
      { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
    )
    // Let the pass reach its awaits (pump sleep + the job's long call)
    // before moving time — advancing earlier would shift the deadlines.
    while (f.clock.fired.length < 2) {
      await new Promise((r) => setTimeout(r, 2))
    }
    // Cross the original lease horizon in pump-cadence hops, sweeping en
    // route; each hop lets pending microtasks (the beat write) settle.
    for (let i = 0; i < 4; i++) {
      await f.advance(30_000)
      await new Promise((r) => setTimeout(r, 2))
      await f.store.sweep(Q, 10)
    }
    expect(await pass).toEqual({ kind: 'completed' })
    expect(beats).toBeGreaterThanOrEqual(2)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })
})

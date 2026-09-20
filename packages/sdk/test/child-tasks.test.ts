import {
  EventTimeoutError,
  type SchedulerStore,
  StoreUnavailableError,
  taskDoneEventName,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type ChildTask, type TaskRegistry, runClaimedRun } from '../src/index.js'
import { expectCleanRows } from './clean-rows.js'
import { Q, claimAndRun, fx, invocationOf, registry } from './worker-harness.js'

type Fixture = Awaited<ReturnType<typeof fx>>

async function taskCount(f: Fixture, taskName: string): Promise<number> {
  const [rows] = await f.raw.batch(
    't',
    [{ sql: 'SELECT COUNT(*) AS n FROM tasks WHERE task_name = ?', args: [taskName] }],
    'read',
  )
  return Number(rows?.rows[0]?.n)
}

async function resultOf(f: Fixture, taskId: string): Promise<unknown> {
  const result = await f.store.getTaskResult(Q, taskId)
  return result?.completedPayloadJson === undefined
    ? result
    : JSON.parse(result.completedPayloadJson)
}

/** ctx.spawn and ctx.awaitTask (DESIGN.md §3.2, specs/ChildTasks.tla). */
describe('child tasks through the SDK', () => {
  it('records a port refusal that task code lets escape under the name of the refusal', async () => {
    const f = await fx('port-refusal-escapes')
    try {
      const reg = registry({
        // Task code that holds a store of its own and calls the port past the SDK.
        forger: async () => {
          await f.store.emitEvent(Q, taskDoneEventName('another-task'), '{}')
        },
      })
      const spawned = await f.store.spawn(Q, 'forger', 'null', { maxAttempts: 1 })
      await claimAndRun(f, reg, 'w1')
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      const failure: unknown = JSON.parse(result?.failureReasonJson ?? 'null')
      expect({ state: result?.state, failure }).toEqual({
        state: 'failed',
        failure: expect.objectContaining({ name: 'PortRefusalError' }),
      })
      await expectCleanRows(f)
    } finally {
      await f.close()
    }
  })

  it('a parent spawns a child, suspends on it, and resumes with its first outcome', async () => {
    const f = await fx('child-basic')
    const reg = registry({
      parent: async (ctx) => {
        const child = await ctx.spawn('child', { n: 20 })
        const outcome = await ctx.awaitTask(child)
        return { state: outcome.state, value: JSON.parse(outcome.completedPayloadJson ?? 'null') }
      },
      child: async (_ctx, params) => (params as { n: number }).n + 1,
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'suspended' })
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'completed' }) // the child
    expect(await claimAndRun(f, reg, 'w3')).toEqual({ kind: 'completed' }) // the woken parent
    expect(await resultOf(f, parent.taskId)).toEqual({ state: 'completed', value: 21 })
    await expectCleanRows(f)
    f.close()
  })

  it('resolves to a failed outcome and does not throw, so the parent decides', async () => {
    const f = await fx('child-failed')
    const reg = registry({
      parent: async (ctx) => {
        const outcome = await ctx.awaitTask(await ctx.spawn('child', null, { maxAttempts: 1 }))
        return { state: outcome.state, failure: JSON.parse(outcome.failureReasonJson ?? 'null') }
      },
      child: async () => {
        throw new Error('child boom')
      },
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'suspended' })
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'failed' })
    expect(await claimAndRun(f, reg, 'w3')).toEqual({ kind: 'completed' })
    expect(await resultOf(f, parent.taskId)).toEqual({
      state: 'failed',
      failure: { name: 'Error', message: 'child boom' },
    })
    await expectCleanRows(f)
    f.close()
  })

  it('a child that ended before the await is read inline, with no suspension', async () => {
    const f = await fx('child-inline')
    const reg = registry({
      parent: async (ctx) => {
        const child = await ctx.spawn('child', null)
        await ctx.sleepFor(30)
        return (await ctx.awaitTask(child)).state
      },
      child: async () => 'done',
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'suspended' }) // the sleep
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'completed' }) // the child
    await f.advance(31_000)
    expect(await claimAndRun(f, reg, 'w3')).toEqual({ kind: 'completed' })
    expect(await resultOf(f, parent.taskId)).toBe('completed')
    await expectCleanRows(f)
    f.close()
  })

  it('a spawn whose checkpoint was lost finds the same child on the next pass', async () => {
    const f = await fx('child-idempotent')
    const reg = registry({
      parent: async (ctx) => (await ctx.awaitTask(await ctx.spawn('child', null))).state,
      child: async () => 'done',
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    // The pass dies after the spawn committed and before its checkpoint does.
    let failed = false
    const flaky = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'setCheckpoint' && !failed) {
          return () => {
            failed = true
            return Promise.reject(new StoreUnavailableError('lost after the spawn'))
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SchedulerStore
    const [first] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!first) throw new Error('claim')
    expect(
      await runClaimedRun({ store: flaky, clock: f.clock, registry: reg }, invocationOf(first)),
    ).toEqual({ kind: 'aborted' })
    expect(await taskCount(f, 'child')).toBe(1)
    // The lease expires, the sweep replaces the run, and the new pass spawns again.
    await f.advance(61_000)
    await f.store.sweep(Q, 10)
    await f.advance(6_000)
    for (let pass = 0; pass < 4; pass++) {
      const [run] = await f.store.claim(Q, `w-after-${pass}`, { leaseSeconds: 60, limit: 1 })
      if (!run) break
      await runClaimedRun({ store: f.store, clock: f.clock, registry: reg }, invocationOf(run))
    }
    expect(
      { children: await taskCount(f, 'child'), parent: await resultOf(f, parent.taskId) },
      'mutation-verdict:behavior:sdk-spawn-is-idempotent-under-replay',
    ).toEqual({ children: 1, parent: 'completed' })
    await expectCleanRows(f)
    f.close()
  })

  it('two spawns of one task name are two children, and a replay keeps them apart', async () => {
    const f = await fx('child-two')
    const reg = registry({
      parent: async (ctx) => {
        const first = await ctx.spawn('child', 1)
        const second = await ctx.spawn('child', 2)
        const outcomes = [await ctx.awaitTask(second), await ctx.awaitTask(first)]
        return outcomes.map((outcome) => JSON.parse(outcome.completedPayloadJson ?? 'null'))
      },
      child: async (_ctx, params) => params,
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    for (let pass = 0; pass < 6; pass++) {
      const [run] = await f.store.claim(Q, `w${pass}`, { leaseSeconds: 60, limit: 1 })
      if (!run) break
      await runClaimedRun({ store: f.store, clock: f.clock, registry: reg }, invocationOf(run))
    }
    expect({
      children: await taskCount(f, 'child'),
      parent: await resultOf(f, parent.taskId),
    }).toEqual({ children: 2, parent: [2, 1] })
    await expectCleanRows(f)
    f.close()
  })

  it('awaiting a child in another queue fails the parent for good, without a retry', async () => {
    const f = await fx('child-cross-queue')
    const reg = registry({
      parent: async (ctx) => {
        const child = await ctx.spawn('child', null, { queue: 'elsewhere' })
        return (await ctx.awaitTask(child)).state
      },
    })
    const parent = await f.store.spawn(Q, 'parent', '{}', { maxAttempts: 3 })
    expect(
      await claimAndRun(f, reg, 'w1'),
      'mutation-verdict:behavior:sdk-child-await-refusal-is-permanent',
    ).toEqual({ kind: 'failed' })
    const result = await f.store.getTaskResult(Q, parent.taskId)
    expect({
      state: result?.state,
      failure: JSON.parse(result?.failureReasonJson ?? 'null').name,
      waits: (
        await f.raw.batch('t', [{ sql: 'SELECT COUNT(*) AS n FROM waits', args: [] }], 'read')
      )[0]?.rows[0]?.n,
    }).toEqual({ state: 'failed', failure: 'FatalTaskError', waits: 0 })
    await expectCleanRows(f)
    f.close()
  })

  it('a timed await of a child that does not end throws EventTimeoutError, memoized', async () => {
    const f = await fx('child-timeout')
    const reg: TaskRegistry = registry({
      parent: async (ctx) => {
        const child = await ctx.spawn('stuck', null)
        try {
          await ctx.awaitTask(child, { timeoutSeconds: 30 })
          return 'unexpected'
        } catch (error) {
          if (!(error instanceof EventTimeoutError)) throw error
          await ctx.sleepFor(5)
          // What the task sees names the task it awaited, and never the engine's event.
          const seen = error as EventTimeoutError & { taskId?: unknown }
          return {
            name: seen.name,
            awaited: seen.taskId === child.taskId,
            leaksTheEngineName: `${seen.message} ${seen.eventName}`.includes(taskDoneEventName('')),
          }
        }
      },
      stuck: async (ctx) => {
        await ctx.sleepFor(100_000)
      },
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'suspended' })
    expect(await claimAndRun(f, reg, 'w2')).toEqual({ kind: 'suspended' }) // the stuck child
    await f.advance(31_000)
    expect(await claimAndRun(f, reg, 'w3')).toEqual({ kind: 'suspended' }) // timed out, now sleeping
    await f.advance(6_000)
    expect(await claimAndRun(f, reg, 'w4')).toEqual({ kind: 'completed' }) // the timeout replays
    expect(
      await resultOf(f, parent.taskId),
      'mutation-verdict:behavior:sdk-child-timeout-names-the-task',
    ).toEqual({ name: 'TaskTimeoutError', awaited: true, leaksTheEngineName: false })
    await expectCleanRows(f)
    f.close()
  })

  it('fails the parent for good when a spawn names a queue or a header no store can keep', async () => {
    const f = await fx('child-undurable')
    const outcomes: Record<string, unknown> = {}
    for (const [name, opts] of [
      ['nul queue', { queue: 'q\u0000tail' }],
      ['lone surrogate queue', { queue: 'q\ud800' }],
      ['nul header', { headers: { 'x\u0000': 'v' } }],
    ] as const) {
      const reg = registry({ parent: async (ctx) => ctx.spawn('child', null, opts) })
      const parent = await f.store.spawn(Q, 'parent', '{}', { maxAttempts: 3 })
      const outcome = await claimAndRun(f, reg, `w-${name}`)
      const result = await f.store.getTaskResult(Q, parent.taskId)
      outcomes[name] = {
        outcome: outcome.kind,
        failure: JSON.parse(result?.failureReasonJson ?? 'null')?.name,
      }
    }
    const permanent = { outcome: 'failed', failure: 'FatalTaskError' }
    expect(
      { outcomes, children: await taskCount(f, 'child') },
      'mutation-verdict:behavior:sdk-spawn-undurable-input-is-permanent',
    ).toEqual({
      outcomes: {
        'nul queue': permanent,
        'lone surrogate queue': permanent,
        'nul header': permanent,
      },
      children: 0,
    })
    f.close()
  })

  // A recorded outcome that cannot be read is the same on every pass, like a refused
  // await: retrying the parent would rerun every side effect before the await and throw
  // the same error again, until the budget is gone.
  it("fails the parent for good when the child's recorded outcome cannot be read", async () => {
    const f = await fx('child-unreadable')
    const outcomes: Record<string, unknown> = {}
    for (const [name, corrupt] of [
      ['a payload that is not text', `x'00'`],
      ['an outcome that is not terminal', `'{"state":"running"}'`],
    ] as const) {
      const child = await f.store.spawn(Q, 'child', '{}')
      const reg = registry({
        child: async () => 1,
        parent: async (ctx) => ctx.awaitTask({ taskId: child.taskId, queue: Q } as ChildTask),
      })
      expect(await claimAndRun(f, reg, `w-child-${name}`)).toEqual({ kind: 'completed' })
      await f.raw.batch('a-writer-that-is-not-the-engine', [
        {
          sql: `UPDATE events SET payload = ${corrupt} WHERE event_name = ?`,
          args: [taskDoneEventName(child.taskId)],
        },
      ])
      const parent = await f.store.spawn(Q, 'parent', '{}', { maxAttempts: 3 })
      const outcome = await claimAndRun(f, reg, `w-parent-${name}`)
      const result = await f.store.getTaskResult(Q, parent.taskId)
      outcomes[name] = {
        outcome: outcome.kind,
        failure: JSON.parse(result?.failureReasonJson ?? 'null')?.name,
      }
      // Whatever became of this parent, the next round starts from an empty queue.
      await f.store.cancelTask(Q, parent.taskId)
    }
    const permanent = { outcome: 'failed', failure: 'FatalTaskError' }
    expect(outcomes, 'mutation-verdict:behavior:sdk-child-outcome-error-is-permanent').toEqual({
      'a payload that is not text': permanent,
      'an outcome that is not terminal': permanent,
    })
    f.close()
  })

  it('refuses a handle that is not a child task, a reserved task name, and nesting in a step', async () => {
    const f = await fx('child-refusals')
    const failures: string[] = []
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run()
        failures.push(`${label}: accepted`)
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.name : String(error)}`)
      }
    }
    const reg = registry({
      parent: async (ctx) => {
        await attempt('handle', () => ctx.awaitTask({ taskId: 7 } as unknown as ChildTask))
        await attempt('reserved name', () => ctx.spawn('$engine', null))
        await attempt('counter name', () => ctx.spawn('a#2', null))
        await attempt('empty queue', () => ctx.spawn('child', null, { queue: '' }))
        await attempt('bad option', () => ctx.spawn('child', null, { maxAttempts: 0 }))
        await ctx.step('outer', async () => {
          await attempt('nested', () => ctx.spawn('child', null))
        })
        return failures
      },
    })
    const parent = await f.store.spawn(Q, 'parent', '{}')
    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'completed' })
    expect(
      await resultOf(f, parent.taskId),
      'mutation-verdict:behavior:sdk-spawn-refusal-is-permanent',
    ).toEqual([
      'handle: FatalTaskError',
      'reserved name: FatalTaskError',
      'counter name: FatalTaskError',
      'empty queue: FatalTaskError',
      'bad option: FatalTaskError',
      'nested: FatalTaskError',
    ])
    expect(await taskCount(f, 'child')).toBe(0)
    f.close()
  })
})

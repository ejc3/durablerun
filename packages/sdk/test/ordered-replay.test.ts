import {
  FatalTaskError,
  PermanentStoreError,
  type SchedulerStore,
  StoreUnavailableError,
} from '@durablerun/core'
import { withStoreOverrides } from '@durablerun/harness'
import { describe, expect, it } from 'vitest'
import { type TaskContext, runClaimedRun } from '../src/index.js'
import { expectCleanRows } from './clean-rows.js'
import { SAGA_DIALECTS, drive, runNext } from './saga-harness.js'
import { Q, claimInvocation, fx, registry } from './worker-harness.js'

type Fixture = Awaited<ReturnType<typeof fx>>

/** A turn of the event loop, after every promise callback that is queued now. */
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * What a promise did after `turns` turns of the event loop: it settled, or it is still
 * pending. A pass that waits for ever fails a case by this answer and not by a timeout.
 */
async function settlesWithin<T>(
  promise: Promise<T>,
  turns = 300,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let outcome: { settled: true; value: T } | undefined
  void promise.then((value) => {
    outcome = { settled: true, value }
  })
  for (let turn = 0; turn < turns && outcome === undefined; turn++) await macrotask()
  return outcome ?? { settled: false }
}

const RETRY_AT_ONCE = { maxAttempts: 2, retryStrategy: { kind: 'fixed', baseSeconds: 0 } } as const

/** The state an await stores for an event that carried `payload`. */
const answered = (payload: string): string =>
  JSON.stringify({ payloadJson: JSON.stringify(payload) })

/**
 * A task that a first pass left with `rows` stored and then failed, so the next pass is the
 * one a case runs. A row is a name and its state, and the case says what the rows are: the
 * order markers are written here by hand, as a first pass would have left them.
 */
async function leftBy(f: Fixture, taskName: string, rows: readonly (readonly [string, string])[]) {
  const spawned = await f.store.spawn(Q, taskName, '{}', RETRY_AT_ONCE)
  const [run] = await f.store.claim(Q, 'w0', { leaseSeconds: 60, limit: 1 })
  if (run === undefined) throw new Error('expected a run')
  for (const [name, state] of rows) {
    await f.store.setCheckpoint(Q, spawned.taskId, run.runId, run.claimToken, name, state, 60)
  }
  await f.store.fail(Q, run.runId, run.claimToken, '"the first pass fails"', { delaySeconds: 0 })
  return spawned
}

/** One pass over the next run that is due. */
async function passOver(f: Fixture, reg: ReturnType<typeof registry>, token: string) {
  return runClaimedRun(
    { store: f.store, clock: f.clock, registry: reg },
    await claimInvocation(f, token),
  )
}

/** The rows a task left, by name, with the order markers apart. */
async function rowsOf(f: Fixture, taskId: string) {
  const [rows] = await f.raw.batch(
    't',
    [
      {
        sql: 'SELECT checkpoint_name, state FROM checkpoints WHERE task_id = ? ORDER BY checkpoint_name',
        args: [taskId],
      },
    ],
    'read',
  )
  const all = (rows?.rows ?? []).map((row) => ({
    name: String(row.checkpoint_name),
    state: String(row.state),
  }))
  return {
    markers: all.filter((row) => row.name.startsWith('$order:')),
    results: all.filter((row) => !row.name.startsWith('$order:')),
  }
}

/** Every checkpoint write the store accepted, in the order it accepted them. */
function writesOf(store: SchedulerStore, accepted: string[]): SchedulerStore {
  return withStoreOverrides(store, {
    setCheckpoint: async (...args) => {
      await store.setCheckpoint(...args)
      accepted.push(args[4])
    },
  })
}

describe('order markers through the SDK', () => {
  it('stores no marker for a task that makes one call at a time', async () => {
    const f = await fx('order-sequential')
    try {
      const reg = registry({
        job: async (ctx: TaskContext) => {
          const a = await ctx.step('a', () => 1)
          const b = await ctx.step('b', () => 2)
          await ctx.emitEvent('go', '1')
          const payload = await ctx.awaitEvent('go')
          const child = await ctx.spawn('kid', null)
          return [a, b, payload, child.queue]
        },
        kid: async () => 1,
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      expect(await passOver(f, reg, 'w1')).toEqual({ kind: 'completed' })
      const rows = await rowsOf(f, spawned.taskId)
      expect(rows.markers).toEqual([])
      expect(rows.results.map((row) => row.name)).toEqual(['$await:go', '$spawn:kid', 'a', 'b'])
      await expectCleanRows(f)
    } finally {
      await f.close()
    }
  })

  it('stores a marker for each of two awaits made together, and before the result it names', async () => {
    const f = await fx('order-group')
    try {
      const accepted: string[] = []
      const store = writesOf(f.store, accepted)
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('x', '1')
          await ctx.emitEvent('y', '2')
          return Promise.all([ctx.awaitEvent('x'), ctx.awaitEvent('y')])
        },
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const outcome = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w1'),
      )
      expect(outcome).toEqual({ kind: 'completed' })
      const rows = await rowsOf(f, spawned.taskId)
      expect(
        rows.markers,
        'mutation-verdict:behavior:order-marker-is-stored-for-calls-pending-together',
      ).toEqual([
        { name: '$order:1', state: JSON.stringify('$await:x') },
        { name: '$order:2', state: JSON.stringify('$await:y') },
      ])
      const at = (name: string) => accepted.indexOf(name)
      expect(accepted).toHaveLength(4)
      expect(
        [at('$order:1') < at('$await:x'), at('$order:2') < at('$await:y')],
        'mutation-verdict:behavior:order-marker-is-stored-before-its-result',
      ).toEqual([true, true])
      await expectCleanRows(f)
    } finally {
      await f.close()
    }
  })

  it('stores the place of a sleep that was made beside another call', async () => {
    const f = await fx('order-sleep')
    try {
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('x', '1')
          return Promise.all([ctx.awaitEvent('x'), ctx.sleepFor(5)])
        },
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      expect(await passOver(f, reg, 'w1')).toEqual({ kind: 'suspended' })
      const rows = await rowsOf(f, spawned.taskId)
      expect(
        rows.markers.map((row) => JSON.parse(row.state)),
        'mutation-verdict:behavior:order-marker-is-stored-for-a-sleep-pending-beside-a-call',
      ).toContain('$sleep')
    } finally {
      await f.close()
    }
  })

  it('replays a task whose rows carry no markers in the order its calls come, as it did before markers', async () => {
    const f = await fx('order-legacy')
    try {
      const flows = async (ctx: TaskContext) =>
        Promise.all(
          [0, 1].map(async (flow) => {
            const payload = await ctx.awaitEvent(`e${flow}`)
            const recorded = await ctx.step('rec', () => `live-${flow}`)
            return `${payload}/${recorded}`
          }),
        )
      // What a build without markers stored: the two awaits, and two results under one name.
      const spawned = await leftBy(f, 'job', [
        ['$await:e0', answered('p0')],
        ['$await:e1', answered('p1')],
        ['rec', '"first"'],
        ['rec#2', '"second"'],
      ])
      expect(await passOver(f, registry({ job: flows }), 'w1')).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toEqual([
        '"p0"/first',
        '"p1"/second',
      ])
      expect((await rowsOf(f, spawned.taskId)).markers).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('ignores a marker whose result was never stored, and does not reuse its number', async () => {
    const f = await fx('order-orphan')
    try {
      // A pass that stored the marker of the await of `x` and died before the await's result.
      const spawned = await leftBy(f, 'job', [['$order:7', '"$await:x"']])
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('x', '1')
          await ctx.emitEvent('y', '2')
          return Promise.all([ctx.awaitEvent('x'), ctx.awaitEvent('y')])
        },
      })
      const pass = await settlesWithin(passOver(f, reg, 'w1'))
      expect(pass, 'mutation-verdict:behavior:order-marker-without-a-result-names-nothing').toEqual(
        { settled: true, value: { kind: 'completed' } },
      )
      const rows = await rowsOf(f, spawned.taskId)
      expect(
        rows.markers.map((row) => row.name),
        'mutation-verdict:behavior:order-numbers-are-never-reused',
      ).toEqual(['$order:7', '$order:8', '$order:9'])
    } finally {
      await f.close()
    }
  })

  it('takes the highest of the markers that name one result', async () => {
    const f = await fx('order-highest')
    try {
      // The marker of the await of `x` was stored by a pass that died before the result, and
      // stored again, higher, by the pass that finished it: `y` was handed over first.
      await leftBy(f, 'job', [
        ['$await:x', answered('1')],
        ['$await:y', answered('2')],
        ['$order:1', '"$await:x"'],
        ['$order:2', '"$await:y"'],
        ['$order:3', '"$await:x"'],
      ])
      const log: string[] = []
      const reg = registry({
        job: async (ctx: TaskContext) =>
          Promise.all(
            ['x', 'y'].map(async (name) => {
              await ctx.awaitEvent(name)
              log.push(name)
            }),
          ),
      })
      const pass = await settlesWithin(passOver(f, reg, 'w1'))
      expect(pass.settled).toBe(true)
      expect(
        log,
        'mutation-verdict:behavior:the-highest-marker-of-a-result-is-the-one-that-counts',
      ).toEqual(['y', 'x'])
    } finally {
      await f.close()
    }
  })
})

describe('a replay follows the order a first pass recorded', () => {
  /** Two flows that each await an event and then log their name, after `hops[flow]` promise turns. */
  const loggingFlows = (log: string[], hops: readonly [number, number] = [0, 0]) =>
    registry({
      job: async (ctx: TaskContext) =>
        Promise.all(
          (['e1', 'e2'] as const).map(async (name, flow) => {
            await ctx.awaitEvent(name)
            for (let hop = 0; hop < (hops[flow] ?? 0); hop++) await Promise.resolve()
            log.push(name)
          }),
        ),
    })

  it('hands recorded results to the task in the order they were recorded, not the order its calls come in', async () => {
    const f = await fx('order-replay-recorded')
    try {
      await leftBy(f, 'job', [
        ['$await:e1', answered('1')],
        ['$await:e2', answered('2')],
        ['$order:1', '"$await:e2"'],
        ['$order:2', '"$await:e1"'],
      ])
      const log: string[] = []
      const pass = await settlesWithin(passOver(f, loggingFlows(log), 'w1'))
      expect(pass.settled).toBe(true)
      expect(
        log,
        'mutation-verdict:behavior:recorded-results-are-handed-over-in-recorded-order',
      ).toEqual(['e2', 'e1'])
    } finally {
      await f.close()
    }
  })

  it('lets what the task does with a result finish before it hands over the next recorded one', async () => {
    const f = await fx('order-replay-turn')
    try {
      await leftBy(f, 'job', [
        ['$await:e1', answered('1')],
        ['$await:e2', answered('2')],
        ['$order:1', '"$await:e1"'],
        ['$order:2', '"$await:e2"'],
      ])
      const log: string[] = []
      // The first flow does eight promise turns of work before its next call, the second none.
      const pass = await settlesWithin(passOver(f, loggingFlows(log, [8, 0]), 'w1'))
      expect(pass.settled).toBe(true)
      expect(
        log,
        'mutation-verdict:behavior:a-recorded-result-is-followed-by-a-turn-of-the-event-loop',
      ).toEqual(['e1', 'e2'])
    } finally {
      await f.close()
    }
  })

  it('queues a result the pass produces behind the recorded results that its flows have not asked for yet', async () => {
    const f = await fx('order-replay-live')
    try {
      // The first pass handed over the await of `e1`, and the flow that makes it is slow to
      // get there on this pass. The await of `e2` is new, and answered at once.
      await leftBy(f, 'job', [
        ['$await:e1', answered('1')],
        ['$order:1', '"$await:e1"'],
      ])
      const log: string[] = []
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('e2', '2')
          await Promise.all([
            (async () => {
              for (let turn = 0; turn < 4; turn++) await macrotask()
              await ctx.awaitEvent('e1')
              log.push('e1')
            })(),
            (async () => {
              await ctx.awaitEvent('e2')
              log.push('e2')
            })(),
          ])
        },
      })
      const pass = await settlesWithin(passOver(f, reg, 'w1'))
      expect(pass.settled).toBe(true)
      expect(
        log,
        'mutation-verdict:behavior:a-result-the-pass-produces-waits-for-the-recorded-ones',
      ).toEqual(['e1', 'e2'])
    } finally {
      await f.close()
    }
  })

  it('lets what the task does with a result finish before it hands over the next result of the same pass', async () => {
    const f = await fx('order-live-turn')
    try {
      const log: string[] = []
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('e1', '1')
          await ctx.emitEvent('e2', '2')
          await Promise.all(
            (['e1', 'e2'] as const).map(async (name, flow) => {
              await ctx.awaitEvent(name)
              // The first flow does eight promise turns of work before it logs, the second none.
              for (let hop = 0; hop < (flow === 0 ? 8 : 0); hop++) await Promise.resolve()
              log.push(name)
            }),
          )
        },
      })
      await f.store.spawn(Q, 'job', '{}')
      const pass = await settlesWithin(passOver(f, reg, 'w1'))
      expect(pass.settled).toBe(true)
      expect(
        log,
        'mutation-verdict:behavior:a-result-the-pass-produces-is-followed-by-a-turn-of-the-event-loop',
      ).toEqual(['e1', 'e2'])
    } finally {
      await f.close()
    }
  })

  it('does not let a call that failed hold up a call that is answered after it', async () => {
    const f = await fx('order-failed-call')
    try {
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('x', '1')
          // The step returns a value that cannot be stored, so its own call fails, and the
          // await beside it is answered after it.
          const settled = await Promise.allSettled([
            ctx.awaitEvent('x'),
            ctx.step('unstorable', () => 10n as never),
          ])
          return settled.map((one) => one.status)
        },
      })
      await f.store.spawn(Q, 'job', '{}')
      const pass = await settlesWithin(passOver(f, reg, 'w1'))
      expect(
        pass,
        'mutation-verdict:behavior:a-call-that-failed-does-not-hold-up-the-calls-behind-it',
      ).toEqual({ settled: true, value: { kind: 'completed' } })
    } finally {
      await f.close()
    }
  })
})

describe('a pass that was told the run cannot go on for its flows', () => {
  it('stores nothing more, and does not complete a task that caught the error', async () => {
    const f = await fx('order-fence')
    try {
      let failed = false
      const accepted: string[] = []
      const store = withStoreOverrides(f.store, {
        setCheckpoint: async (...args) => {
          if (!failed && args[4] === 'a') {
            failed = true
            throw new StoreUnavailableError('injected outage')
          }
          await f.store.setCheckpoint(...args)
          accepted.push(args[4])
        },
      })
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('x', '1')
          // The task swallows what its first call threw. Its second flow has an await pending
          // beside the first call, and then makes a call of its own.
          const settled = await Promise.allSettled([
            (async () => {
              await ctx.awaitEvent('x')
              return ctx.step('b', () => 'B')
            })(),
            ctx.step('a', () => 'A'),
          ])
          return settled.map((one) => one.status)
        },
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const outcome = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w1'),
      )
      expect(
        outcome,
        'mutation-verdict:behavior:a-task-that-caught-the-error-that-ended-its-pass-does-not-complete',
      ).toEqual({ kind: 'aborted' })
      expect(
        accepted.filter((name) => name === 'b' || name === '$await:x'),
        'mutation-verdict:behavior:flows-store-nothing-after-an-infrastructure-error-beside-them',
      ).toEqual([])
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(result?.state).not.toBe('completed')
    } finally {
      await f.close()
    }
  })

  it('ends the pass of a task that makes one call at a time and catches the error, and the run completes on its next pass', async () => {
    const f = await fx('order-sequential-catch')
    try {
      let failed = false
      const store = withStoreOverrides(f.store, {
        setCheckpoint: async (...args) => {
          if (!failed && args[4] === 'a') {
            failed = true
            throw new StoreUnavailableError('injected outage')
          }
          await f.store.setCheckpoint(...args)
        },
      })
      const reg = registry({
        job: async (ctx: TaskContext) => {
          try {
            return await ctx.step('a', () => 'A')
          } catch {
            // The task swallows the outage and calls again.
            return await ctx.step('a-again', () => 'A2')
          }
        },
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const first = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w1'),
      )
      expect(
        first,
        'mutation-verdict:behavior:a-store-error-ends-the-pass-whether-or-not-a-call-is-beside-it',
      ).toEqual({
        kind: 'aborted',
      })
      let second: unknown
      for (let round = 0; round < 6 && second === undefined; round++) {
        await f.advance(70_000)
        await f.store.sweep(Q, 10)
        const [run] = await f.store.claim(Q, `w${round + 2}`, { leaseSeconds: 60, limit: 1 })
        if (run === undefined) continue
        second = await runClaimedRun(
          { store: f.store, clock: f.clock, registry: reg },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        )
      }
      expect(second).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toBe('A')
    } finally {
      await f.close()
    }
  })
})

describe('a permanent answer of the store is not an error a retry can fix', () => {
  it('reaches the task, which completes with its fallback in the pass it met it in', async () => {
    const f = await fx('order-permanent')
    try {
      const store = withStoreOverrides(f.store, {
        setCheckpoint: async (...args) => {
          if (args[4] === 'big') throw new PermanentStoreError('injected permanent answer')
          await f.store.setCheckpoint(...args)
        },
      })
      const reg = registry({
        job: async (ctx: TaskContext) => {
          try {
            return await ctx.step('big', () => 'B')
          } catch {
            return 'fallback'
          }
        },
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const first = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w1'),
      )
      expect(
        first,
        'mutation-verdict:behavior:a-permanent-answer-of-the-store-does-not-end-the-pass',
      ).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toBe('fallback')
    } finally {
      await f.close()
    }
  })
})

describe('a replay that waits for a call the task does not make', () => {
  /**
   * Attempt 1 makes three awaits together, the second under a name of its own attempt, and
   * fails. Attempt 2 makes the same three, with the second under the name of attempt 2, so
   * the recorded number of the attempt-1 await is one that no call of attempt 2 asks for,
   * and the await of `a` behind it waits for it.
   */
  const job = async (ctx: TaskContext) => {
    const mine = `b-${ctx.attempt}`
    await ctx.emitEvent('x', '"X"')
    await ctx.emitEvent(mine, `"B${ctx.attempt}"`)
    await ctx.emitEvent('a', '"A"')
    const three = await Promise.all([
      ctx.awaitEvent('x'),
      ctx.awaitEvent(mine),
      ctx.awaitEvent('a'),
    ])
    if (ctx.attempt === 1) throw new Error('the first attempt fails')
    return three
  }

  async function stuckSecondAttempt(f: Fixture) {
    const spawned = await f.store.spawn(Q, 'job', '{}', RETRY_AT_ONCE)
    const reg = registry({ job })
    expect(await passOver(f, reg, 'w1')).toEqual({ kind: 'retry-scheduled' })
    const pass = passOver(f, reg, 'w2')
    // The replay hands over the await of `x`, and then waits for the await of `b-1`.
    const early = await settlesWithin(pass, 30)
    expect(early.settled, 'the replay waits for a call that is never made').toBe(false)
    return { spawned, pass }
  }

  it('gives up on the recorded result of a call it never makes, at the beat of the heartbeat, and finishes', async () => {
    const f = await fx('order-stall')
    try {
      const { spawned, pass } = await stuckSecondAttempt(f)
      // The heartbeat beats at half the lease. The first beat finds results handed over
      // since the pass began, and the second finds none.
      await f.advance(31_000)
      await settlesWithin(pass, 10)
      await f.advance(31_000)
      const ended = await settlesWithin(pass)
      expect(
        ended,
        'mutation-verdict:behavior:the-heartbeat-gives-up-on-a-result-nobody-asks-for',
      ).toEqual({ settled: true, value: { kind: 'completed' } })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toEqual(['"X"', '"B2"', '"A"'])
      await expectCleanRows(f)
    } finally {
      await f.close()
    }
  })

  /**
   * A flow whose result is stored by a write that never answers takes a number of this pass, and
   * the result of a flow beside it waits behind that number. A beat gives up only on numbers of
   * an earlier pass, so only the end of the beats lets the second flow go, and its next store
   * call meets the fence of the run.
   */
  async function heldBehindAWriteThatNeverAnswers(
    seed: string,
    end: 'cancel' | 'heartbeat-outage',
  ) {
    const f = await fx(seed)
    try {
      const store = withStoreOverrides(f.store, {
        setCheckpoint: (...args) =>
          args[4] === 'slow' ? new Promise<void>(() => {}) : f.store.setCheckpoint(...args),
        heartbeat: (...args) =>
          end === 'heartbeat-outage'
            ? Promise.reject(new StoreUnavailableError('injected outage'))
            : f.store.heartbeat(...args),
      })
      const reg = registry({
        job: async (ctx: TaskContext) => {
          await ctx.emitEvent('x', '"X"')
          // The first flow never finishes storing; the race ends with the second flow.
          return Promise.race([
            ctx.step('slow', () => 'S'),
            (async () => {
              // Past the moment the first step's body has run, so the call is not refused as nested.
              for (let turn = 0; turn < 20; turn++) await Promise.resolve()
              await ctx.awaitEvent('x')
              return ctx.step('after', () => 'A')
            })(),
          ])
        },
      })
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const pass = runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w1'),
      )
      const early = await settlesWithin(pass, 30)
      expect(early.settled, 'the second flow waits behind the first flow number').toBe(false)
      if (end === 'cancel') await f.store.cancelTask(Q, spawned.taskId)
      await f.advance(31_000)
      return await settlesWithin(pass)
    } finally {
      await f.close()
    }
  }

  it('lets every call go when the lease ends, though a beat gives up on no number of this pass', async () => {
    const ended = await heldBehindAWriteThatNeverAnswers('order-live-cancelled', 'cancel')
    expect(
      ended.settled,
      'mutation-verdict:behavior:a-pass-whose-lease-ended-lets-every-call-go',
    ).toBe(true)
  })

  it('lets every call go when the heartbeat stops, though a beat gives up on no number of this pass', async () => {
    const ended = await heldBehindAWriteThatNeverAnswers('order-live-outage', 'heartbeat-outage')
    expect(
      ended.settled,
      'mutation-verdict:behavior:a-pass-whose-heartbeat-stopped-lets-every-call-go',
    ).toBe(true)
  })

  it('lets every call go when the heartbeat stops while the replay waits', async () => {
    const f = await fx('order-stall-heartbeat')
    try {
      const store = withStoreOverrides(f.store, {
        heartbeat: () => Promise.reject(new StoreUnavailableError('injected outage')),
      })
      const spawned = await f.store.spawn(Q, 'job', '{}', RETRY_AT_ONCE)
      const reg = registry({ job })
      expect(await passOver(f, reg, 'w1')).toEqual({ kind: 'retry-scheduled' })
      const pass = runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w2'),
      )
      const early = await settlesWithin(pass, 30)
      expect(early.settled, 'the replay waits for a call that is never made').toBe(false)
      // The first beat finds results handed over, and its heartbeat fails: no beat follows.
      await f.advance(31_000)
      const ended = await settlesWithin(pass)
      expect(ended, 'the pass ends').toEqual({ settled: true, value: { kind: 'completed' } })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toEqual(['"X"', '"B2"', '"A"'])
    } finally {
      await f.close()
    }
  })

  it('lets every call go when the lease ends while the replay waits', async () => {
    const f = await fx('order-stall-cancelled')
    try {
      const { spawned, pass } = await stuckSecondAttempt(f)
      await f.store.cancelTask(Q, spawned.taskId)
      // The first beat sees results handed over and is not stuck. Its heartbeat is refused.
      await f.advance(31_000)
      const ended = await settlesWithin(pass)
      expect(ended, 'the pass ends').toEqual({ settled: true, value: { kind: 'cancelled' } })
    } finally {
      await f.close()
    }
  })
})

for (const { dialect, open } of SAGA_DIALECTS) {
  describe(`a rollback pass whose replay holds a flow for its turn [${dialect}]`, () => {
    it('registers the rollback of a step that the held flow started, before it decides what is owed', async () => {
      const f = await open('order-saga-held')
      try {
        const effects: string[] = []
        const reg = registry({
          saga: async (ctx: TaskContext) => {
            await ctx.emitEvent('e1', '1')
            await ctx.emitEvent('e2', '2')
            await Promise.all([
              (async () => {
                await ctx.awaitEvent('e1')
                await ctx.step('fails', () => {
                  throw new FatalTaskError('the first flow fails')
                })
              })(),
              (async () => {
                await ctx.awaitEvent('e2')
                await ctx.step('second', () => 'two', {
                  rollback: () => {
                    effects.push('undo:second')
                  },
                })
              })(),
            ])
          },
        })
        const task = await f.store.spawn(Q, 'saga', '{}')
        // What a first pass left when its first flow failed at once, and the second flow's
        // step had written its start marker before the failure landed: both awaits answered,
        // in the first flow's turn and then the second's, and a step of the second that
        // started and never stored its result.
        const [run] = await f.store.claim(Q, 'w0', { leaseSeconds: 60, limit: 1 })
        if (run === undefined) throw new Error('expected a run')
        for (const [name, state] of [
          ['$await:e1', '{"payloadJson":"1"}'],
          ['$await:e2', '{"payloadJson":"2"}'],
          ['$order:1', '"$await:e1"'],
          ['$order:2', '"$await:e2"'],
          ['$started:second', '1'],
        ] as const) {
          await f.store.setCheckpoint(Q, task.taskId, run.runId, run.claimToken, name, state, 60)
        }
        const failed = await f.store.fail(
          Q,
          run.runId,
          run.claimToken,
          '{"name":"FatalTaskError","message":"the first flow fails"}',
          null,
        )
        expect(failed?.rollingBack).toBe(true)
        const outcomes = await drive(f, reg, task.taskId)
        const result = await f.store.getTaskResult(Q, task.taskId)
        expect(
          { outcomes, effects, state: result?.state, rollback: result?.rollback?.outcome },
          'mutation-verdict:behavior:replay-settles-before-the-rollback-decides',
        ).toEqual({
          outcomes: ['rolled-back'],
          effects: ['undo:second'],
          state: 'failed',
          rollback: 'complete',
        })
      } finally {
        await f.close()
      }
    })
  })
}

describe('a replay that skips recorded calls is not slowed by more than one beat of the heartbeat', () => {
  /**
   * Attempt 1 runs every flow (each awaits an event of its own and then stores a step) and
   * fails. Attempt 2 runs only the flows in `kept`, so the recorded calls of the others are
   * calls the task never makes again. The pass has a beat of 30 seconds (a lease of 60), and
   * it must end after at most one, whatever the number of calls it skips.
   */
  async function skipping(seed: string, flows: number, kept: readonly number[], beats = 1) {
    const f = await fx(seed)
    try {
      const job = async (ctx: TaskContext) => {
        for (let flow = 0; flow < flows; flow++) await ctx.emitEvent(`e${flow}`, `"P${flow}"`)
        const run = ctx.attempt === 1 ? [...Array(flows).keys()] : kept
        const out = await Promise.all(
          run.map(async (flow) => {
            const payload = await ctx.awaitEvent(`e${flow}`)
            return `${payload}/${await ctx.step(`s${flow}`, () => `S${flow}`)}`
          }),
        )
        if (ctx.attempt === 1) throw new Error('the first attempt fails')
        return out
      }
      const spawned = await f.store.spawn(Q, 'job', '{}', RETRY_AT_ONCE)
      const reg = registry({ job })
      expect(await passOver(f, reg, 'w1')).toEqual({ kind: 'retry-scheduled' })
      const pass = passOver(f, reg, 'w2')
      let elapsed = 0
      let ended = await settlesWithin(pass, 60)
      while (!ended.settled && elapsed < beats * 30_000 + 300_000) {
        await f.advance(31_000)
        elapsed += 31_000
        ended = await settlesWithin(pass, 60)
        if (ended.settled) break
      }
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      return {
        elapsedBeats: elapsed / 31_000,
        value: JSON.parse(result?.completedPayloadJson ?? 'null'),
      }
    } finally {
      await f.close()
    }
  }

  it('skips the first of two flows', async () => {
    const seen = await skipping('order-skip-first', 2, [1])
    expect(
      seen.elapsedBeats,
      'mutation-verdict:behavior:a-skipped-recorded-call-is-given-up-within-one-beat',
    ).toBeLessThanOrEqual(1)
    expect(seen.value).toEqual(['"P1"/S1'])
  })

  it('skips two of three flows', async () => {
    const seen = await skipping('order-skip-two', 3, [1])
    expect(
      seen.elapsedBeats,
      'mutation-verdict:behavior:every-skipped-recorded-call-is-given-up-in-the-same-beat',
    ).toBeLessThanOrEqual(1)
    expect(seen.value).toEqual(['"P1"/S1'])
  })

  it('skips the outer flows of four and keeps the middle two', async () => {
    const seen = await skipping('order-skip-outer', 4, [1, 2])
    expect(seen.elapsedBeats).toBeLessThanOrEqual(1)
    expect(seen.value).toEqual(['"P1"/S1', '"P2"/S2'])
  })

  it('skips a flow between two that run, after results were handed over', async () => {
    const seen = await skipping('order-skip-middle', 3, [0, 2])
    expect(
      seen.elapsedBeats,
      'mutation-verdict:behavior:a-wait-is-judged-by-the-results-handed-over-since-it-began',
    ).toBeLessThanOrEqual(1)
    expect(seen.value).toEqual(['"P0"/S0', '"P2"/S2'])
  })
})

describe('a rollback pass whose replay is held', () => {
  it('waits for the release, and does not spin the event loop while it waits', async () => {
    const first = SAGA_DIALECTS[0]
    if (first === undefined) throw new Error('no dialect')
    const f = await first.open('order-saga-spin')
    try {
      let turns = 0
      const clock = Object.create(f.clock) as typeof f.clock
      clock.yieldTurn = () => {
        turns++
        return f.clock.yieldTurn()
      }
      const effects: string[] = []
      // The first pass makes two awaits together and registers a step, and fails. The rollback
      // pass replays without the first await, whose recorded call it never makes, so the result
      // of the second is held for it, and a call with no memo ends the replay while it is held.
      let replaying = false
      const job = async (ctx: TaskContext) => {
        await ctx.emitEvent('ghost', '"G"')
        await ctx.emitEvent('x', '"X"')
        await Promise.all(
          replaying
            ? [ctx.awaitEvent('x'), ctx.awaitEvent('fresh')]
            : [ctx.awaitEvent('ghost'), ctx.awaitEvent('x')],
        )
        await ctx.step('reg', () => 1, { rollback: () => void effects.push('undo') })
        throw new FatalTaskError('fails')
      }
      const reg = registry({ job })
      await f.store.spawn(Q, 'job', '{}')
      expect(await runNext(f, reg, 'w1')).toBe('rolling-back')
      replaying = true
      const [run] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
      if (run === undefined) throw new Error('expected the rollback pass')
      const pass = runClaimedRun(
        { store: f.store, clock, registry: reg },
        { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
      )
      turns = 0
      for (let turn = 0; turn < 100; turn++) await macrotask()
      const held = await settlesWithin(pass, 1)
      expect(held.settled, 'the replay is held').toBe(false)
      expect(
        turns,
        'mutation-verdict:behavior:a-held-rollback-replay-waits-for-the-release',
      ).toBeLessThan(10)
      await f.advance(31_000)
      const ended = await settlesWithin(pass)
      expect(ended.settled).toBe(true)
    } finally {
      await f.close()
    }
  })
})

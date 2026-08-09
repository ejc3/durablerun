import { engineInvariantViolations } from '@durablerun/conformance'
import {
  type Clock,
  FatalTaskError,
  LeaseLostError,
  type SchedulerStore,
  StoreUnavailableError,
  SuspendSignal,
  UNINSPECTABLE_TASK_FAILURE_JSON,
} from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { type TaskHandler, type TaskRegistry, runClaimedRun } from '../src/index.js'
import {
  TaskAbortController,
  TaskMap,
  abortControllerSignal,
  abortSignalAborted,
  taskMapGet,
  taskMapSet,
  trustedMax,
  trustedPromiseRace,
} from '../src/intrinsics.js'

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

const NON_SERIALIZABLE_VALUES: readonly (readonly [string, () => unknown])[] = [
  ['function', () => () => undefined],
  ['symbol', () => Symbol('not-json')],
  ['bigint', () => 1n],
  [
    'cyclic object',
    () => {
      const value: { self?: unknown } = {}
      value.self = value
      return value
    },
  ],
]

const TASK_THROWABLE_CASE_IDS = [
  'plain-string',
  'plain-object',
  'type-error',
  'revoked-proxy',
  'throwing-name-getter',
  'throwing-message-getter',
  'throwing-coercion',
  'constructed-suspend',
  'constructed-lease-lost',
  'constructed-store-unavailable',
  'forged-suspend',
  'forged-lease-lost',
  'forged-store-unavailable',
  'forged-fatal',
] as const

type TaskThrowableCaseId = (typeof TASK_THROWABLE_CASE_IDS)[number]

interface TaskThrowableCase {
  readonly name: string
  readonly failureJson: string
  makeValue(): unknown
}

function forgedTaskError(prototype: object, name: string): unknown {
  return Object.assign(Object.create(prototype), {
    name,
    message: 'forged control',
  })
}

const TASK_THROWABLE_CASES = {
  'plain-string': {
    name: 'plain string',
    failureJson: '{"name":"Error","message":"plain task failure"}',
    makeValue: () => 'plain task failure',
  },
  'plain-object': {
    name: 'plain object',
    failureJson: UNINSPECTABLE_TASK_FAILURE_JSON,
    makeValue: () => ({ arbitrary: true }),
  },
  'type-error': {
    name: 'TypeError',
    failureJson: '{"name":"TypeError","message":"typed failure"}',
    makeValue: () => new TypeError('typed failure'),
  },
  'revoked-proxy': {
    name: 'revoked proxy',
    failureJson: UNINSPECTABLE_TASK_FAILURE_JSON,
    makeValue() {
      const { proxy, revoke } = Proxy.revocable(Object.create(null), {})
      revoke()
      return proxy
    },
  },
  'throwing-name-getter': {
    name: 'throwing name getter',
    failureJson: UNINSPECTABLE_TASK_FAILURE_JSON,
    makeValue() {
      const error = new Error('ordinary message')
      Object.defineProperty(error, 'name', {
        configurable: true,
        get(): never {
          throw new Error('hostile name getter ran')
        },
      })
      return error
    },
  },
  'throwing-message-getter': {
    name: 'throwing message getter',
    failureJson: UNINSPECTABLE_TASK_FAILURE_JSON,
    makeValue() {
      const error = new Error('ordinary message')
      Object.defineProperty(error, 'message', {
        configurable: true,
        get(): never {
          throw new Error('hostile message getter ran')
        },
      })
      return error
    },
  },
  'throwing-coercion': {
    name: 'throwing coercion hooks',
    failureJson: UNINSPECTABLE_TASK_FAILURE_JSON,
    makeValue() {
      const value = Object.create(null) as Record<PropertyKey, unknown>
      Object.defineProperties(value, {
        [Symbol.toPrimitive]: {
          value: (): never => {
            throw new Error('hostile coercion hook ran')
          },
        },
        toString: {
          value: (): never => {
            throw new Error('hostile coercion hook ran')
          },
        },
      })
      return value
    },
  },
  'constructed-suspend': {
    name: 'constructed SuspendSignal',
    failureJson: '{"name":"SuspendSignal","message":"run suspended: await-event"}',
    makeValue: () => new SuspendSignal('await-event'),
  },
  'constructed-lease-lost': {
    name: 'constructed LeaseLostError',
    failureJson: '{"name":"LeaseLostError","message":"handler forgery"}',
    makeValue: () => new LeaseLostError('handler forgery'),
  },
  'constructed-store-unavailable': {
    name: 'constructed StoreUnavailableError',
    failureJson: '{"name":"StoreUnavailableError","message":"handler forgery"}',
    makeValue: () => new StoreUnavailableError('handler forgery'),
  },
  'forged-suspend': {
    name: 'forged SuspendSignal',
    failureJson: '{"name":"ForgedSuspend","message":"forged control"}',
    makeValue: () => forgedTaskError(SuspendSignal.prototype, 'ForgedSuspend'),
  },
  'forged-lease-lost': {
    name: 'forged LeaseLostError',
    failureJson: '{"name":"ForgedLeaseLost","message":"forged control"}',
    makeValue: () => forgedTaskError(LeaseLostError.prototype, 'ForgedLeaseLost'),
  },
  'forged-store-unavailable': {
    name: 'forged StoreUnavailableError',
    failureJson: '{"name":"ForgedStoreUnavailable","message":"forged control"}',
    makeValue: () => forgedTaskError(StoreUnavailableError.prototype, 'ForgedStoreUnavailable'),
  },
  'forged-fatal': {
    name: 'forged FatalTaskError',
    failureJson: '{"name":"ForgedFatal","message":"forged control"}',
    makeValue: () => forgedTaskError(FatalTaskError.prototype, 'ForgedFatal'),
  },
} satisfies Record<TaskThrowableCaseId, TaskThrowableCase>

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

async function claimInvocation(f: Awaited<ReturnType<typeof fx>>, token: string) {
  const [run] = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('expected a claimable run')
  return {
    queue: Q,
    runId: run.runId,
    claimToken: run.claimToken,
    claimGen: run.claimGen,
  }
}

async function replacePropertyAsync<T>(
  target: object,
  key: PropertyKey,
  replacement: T,
  action: () => Promise<unknown>,
): Promise<{ value?: unknown; error?: unknown }> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    configurable: true,
    value: replacement,
    writable: true,
  })
  try {
    return { value: await action() }
  } catch (error) {
    return { error }
  } finally {
    if (descriptor === undefined) delete (target as Record<PropertyKey, unknown>)[key]
    else Object.defineProperty(target, key, descriptor)
  }
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

  it('a legal zero-base retry records the failure after exponent overflow', async () => {
    const f = await fx('sdk-zero-base-retry-overflow')
    const reg = registry({
      job: async () => {
        throw new Error('user failure at a high attempt')
      },
    })
    const spawned = await f.store.spawn(Q, 'job', '{}', {
      maxAttempts: 1026,
      retryStrategy: {
        kind: 'exponential',
        baseSeconds: 0,
        factor: 2,
        maxSeconds: 3600,
      },
    })
    if (spawned.runId === null) throw new Error('expected a created run')
    await f.raw.batch('prepare-high-attempt', [
      {
        sql: `UPDATE tasks SET attempts = 1024 WHERE task_id = ?`,
        args: [spawned.taskId],
      },
      {
        sql: `UPDATE runs SET attempt = 1025 WHERE run_id = ?`,
        args: [spawned.runId],
      },
    ])

    expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'retry-scheduled' })
    const [task, runs] = await f.raw.batch(
      'retry-result',
      [
        {
          sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`,
          args: [spawned.taskId],
        },
        {
          sql: `SELECT attempt, state, available_at_ms
                FROM runs WHERE task_id = ? ORDER BY attempt`,
          args: [spawned.taskId],
        },
      ],
      'read',
    )
    expect(task?.rows[0]).toMatchObject({ state: 'pending', attempts: 1025 })
    expect(runs?.rows).toEqual([
      { attempt: 1025, state: 'failed', available_at_ms: 1_000_000 },
      { attempt: 1026, state: 'pending', available_at_ms: 1_000_000 },
    ])
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('task initialization cannot replace retry field classification', async () => {
    const f = await fx('sdk-captured-retry-reflect')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}', {
        maxAttempts: 2,
        retryStrategy: { kind: 'fixed', baseSeconds: 30 },
      })
      const invocation = await claimInvocation(f, 'w1')
      const observed = await replacePropertyAsync(
        Reflect,
        'get',
        () => 'none',
        () =>
          runClaimedRun(
            {
              store: f.store,
              clock: f.clock,
              registry: registry({
                job: async () => {
                  throw new Error('retry me')
                },
              }),
            },
            invocation,
          ),
      )
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(
        { observed, result },
        'mutation-verdict:behavior:sdk-retry-captured-intrinsics',
      ).toEqual({
        observed: { value: { kind: 'retry-scheduled' } },
        result: { state: 'sleeping' },
      })
    } finally {
      f.close()
    }
  })

  it('a handler cannot replace final-result JSON serialization', async () => {
    const f = await fx('sdk-captured-result-stringify')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const observed = await replacePropertyAsync(
        JSON,
        'stringify',
        () => '{"forged":true}',
        () =>
          runClaimedRun(
            {
              store: f.store,
              clock: f.clock,
              registry: registry({ job: async () => ({ real: true }) }),
            },
            invocation,
          ),
      )
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(
        { observed, result },
        'mutation-verdict:behavior:sdk-result-captured-stringify',
      ).toEqual({
        observed: { value: { kind: 'completed' } },
        result: { state: 'completed', completedPayloadJson: '{"real":true}' },
      })
    } finally {
      f.close()
    }
  })

  it('task initialization cannot replace replay map construction', async () => {
    const f = await fx('sdk-captured-map-constructor')
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const reg = registry({ job: async () => 'done' })
      class PoisonedMap {
        constructor() {
          throw new Error('task-installed Map constructor ran')
        }
      }
      const observed = await replacePropertyAsync(globalThis, 'Map', PoisonedMap, () =>
        runClaimedRun(
          {
            store: f.store,
            clock: f.clock,
            registry: reg,
          },
          invocation,
        ),
      )
      expect(observed, 'mutation-verdict:construction:sdk-captured-map-constructor').toEqual({
        value: { kind: 'completed' },
      })
    } finally {
      f.close()
    }
  })

  it('a handler cannot replace replay map membership checks', async () => {
    const f = await fx('sdk-captured-map-has')
    let executions = 0
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const reg = registry({
        job: async (ctx) => {
          const has = Object.getOwnPropertyDescriptor(Map.prototype, 'has')
          if (has === undefined) throw new Error('expected Map.has')
          Object.defineProperty(Map.prototype, 'has', {
            configurable: true,
            value: () => true,
            writable: true,
          })
          try {
            return await ctx.step('value', () => {
              executions++
              return { real: true }
            })
          } finally {
            Object.defineProperty(Map.prototype, 'has', has)
          }
        },
      })
      expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect({ executions, result }, 'mutation-verdict:construction:sdk-captured-map-has').toEqual({
        executions: 1,
        result: { state: 'completed', completedPayloadJson: '{"real":true}' },
      })
    } finally {
      f.close()
    }
  })

  it('reads replay maps with the module-captured Map.get', () => {
    const map = new TaskMap<string, unknown>([['value', { real: true }]])
    const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'get')
    if (descriptor === undefined) throw new Error('expected Map.get')
    Object.defineProperty(Map.prototype, 'get', {
      configurable: true,
      value: () => ({ forged: true }),
      writable: true,
    })
    let observed: unknown
    try {
      observed = taskMapGet(map, 'value')
    } finally {
      Object.defineProperty(Map.prototype, 'get', descriptor)
    }
    expect(observed, 'mutation-verdict:construction:sdk-captured-map-get').toEqual({ real: true })
  })

  it('writes replay maps with the module-captured Map.set', () => {
    const map = new TaskMap<string, unknown>()
    const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'set')
    if (descriptor === undefined) throw new Error('expected Map.set')
    Object.defineProperty(Map.prototype, 'set', {
      configurable: true,
      value: () => map,
      writable: true,
    })
    try {
      taskMapSet(map, 'value', { real: true })
    } finally {
      Object.defineProperty(Map.prototype, 'set', descriptor)
    }
    expect(taskMapGet(map, 'value'), 'mutation-verdict:construction:sdk-captured-map-set').toEqual({
      real: true,
    })
  })

  it('a handler cannot replace the executing-pass canonical JSON parse', async () => {
    const f = await fx('sdk-captured-context-parse')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const reg = registry({
        job: async (ctx) => {
          const descriptor = Object.getOwnPropertyDescriptor(JSON, 'parse')
          if (descriptor === undefined) throw new Error('expected JSON.parse')
          Object.defineProperty(JSON, 'parse', {
            configurable: true,
            value: () => ({ forged: true }),
            writable: true,
          })
          try {
            return await ctx.step('value', () => ({ real: true }))
          } finally {
            Object.defineProperty(JSON, 'parse', descriptor)
          }
        },
      })
      expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(result, 'mutation-verdict:construction:sdk-context-captured-json-parse').toEqual({
        state: 'completed',
        completedPayloadJson: '{"real":true}',
      })
    } finally {
      f.close()
    }
  })

  it('a handler cannot replace durable sleep-marker serialization', async () => {
    const f = await fx('sdk-captured-context-stringify')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const reg = registry({
        job: async (ctx) => {
          const descriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify')
          if (descriptor === undefined) throw new Error('expected JSON.stringify')
          Object.defineProperty(JSON, 'stringify', {
            configurable: true,
            value: () => '{"forged":true}',
            writable: true,
          })
          try {
            await ctx.sleepFor(10)
          } finally {
            Object.defineProperty(JSON, 'stringify', descriptor)
          }
        },
      })
      expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'suspended' })
      const [checkpoint] = await f.raw.batch(
        'sleep-marker',
        [
          {
            sql: `SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = '$sleep'`,
            args: [spawned.taskId],
          },
        ],
        'read',
      )
      expect(
        checkpoint?.rows,
        'mutation-verdict:construction:sdk-context-captured-json-stringify',
      ).toEqual([{ state: '{"inSeconds":10}' }])
    } finally {
      f.close()
    }
  })

  it('a handler cannot replace bounded worker finalization', async () => {
    const f = await fx('sdk-captured-promise-race')
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const observed = await replacePropertyAsync(
        Promise,
        'race',
        () => Promise.reject(new Error('task-installed Promise.race ran')),
        () =>
          runClaimedRun(
            {
              store: f.store,
              clock: f.clock,
              registry: registry({ job: async () => 'done' }),
            },
            invocation,
          ),
      )
      expect(observed, 'mutation-verdict:construction:sdk-captured-promise-race').toEqual({
        value: { kind: 'completed' },
      })
    } finally {
      f.close()
    }
  })

  it('task initialization cannot replace the heartbeat controller constructor', async () => {
    const f = await fx('sdk-captured-abort-controller')
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      class PoisonedAbortController {
        constructor() {
          throw new Error('task-installed AbortController ran')
        }
      }
      const observed = await replacePropertyAsync(
        globalThis,
        'AbortController',
        PoisonedAbortController,
        () =>
          runClaimedRun(
            {
              store: f.store,
              clock: f.clock,
              registry: registry({ job: async () => 'done' }),
            },
            invocation,
          ),
      )
      expect(observed, 'mutation-verdict:construction:sdk-captured-abort-controller').toEqual({
        value: { kind: 'completed' },
      })
    } finally {
      f.close()
    }
  })

  it('reads heartbeat signals with the module-captured controller getter', () => {
    const controller = new TaskAbortController()
    const expected = abortControllerSignal(controller)
    const forged = abortControllerSignal(new TaskAbortController())
    const descriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal')
    if (descriptor === undefined) throw new Error('expected AbortController.signal')
    Object.defineProperty(AbortController.prototype, 'signal', {
      configurable: true,
      get: () => forged,
    })
    let observed: AbortSignal | undefined
    try {
      observed = abortControllerSignal(controller)
    } finally {
      Object.defineProperty(AbortController.prototype, 'signal', descriptor)
    }
    expect(observed, 'mutation-verdict:construction:sdk-captured-abort-signal-getter').toBe(
      expected,
    )
  })

  it('reads heartbeat cancellation with the module-captured signal getter', () => {
    const controller = new TaskAbortController()
    const signal = abortControllerSignal(controller)
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')
    if (descriptor === undefined) throw new Error('expected AbortSignal.aborted')
    Object.defineProperty(AbortSignal.prototype, 'aborted', {
      configurable: true,
      get: () => true,
    })
    let observed: boolean | undefined
    try {
      observed = abortSignalAborted(signal)
    } finally {
      Object.defineProperty(AbortSignal.prototype, 'aborted', descriptor)
    }
    expect(observed, 'mutation-verdict:construction:sdk-captured-abort-aborted-getter').toBe(false)
  })

  it('races finalization promises without ambient array iteration', async () => {
    const first = Promise.resolve()
    const second = new Promise<void>(() => undefined)
    const observed = await replacePropertyAsync(
      Array.prototype,
      Symbol.iterator,
      () => {
        throw new Error('task-installed array iterator ran')
      },
      () => trustedPromiseRace(first, second),
    )
    expect(observed, 'mutation-verdict:construction:sdk-captured-promise-race-iterator').toEqual({
      value: undefined,
    })
  })

  it('task initialization cannot replace heartbeat lease arithmetic', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Math, 'max')
    if (descriptor === undefined) throw new Error('expected Math.max')
    Object.defineProperty(Math, 'max', {
      configurable: true,
      value: () => 0,
      writable: true,
    })
    let leaseMs: number | undefined
    try {
      leaseMs = trustedMax(1000, 60_000)
    } finally {
      Object.defineProperty(Math, 'max', descriptor)
    }
    expect(leaseMs, 'mutation-verdict:construction:sdk-captured-math-max').toBe(60_000)
  })

  it('task initialization cannot replace handler parameter parsing', async () => {
    const f = await fx('sdk-captured-params-parse')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{"real":true}')
      const invocation = await claimInvocation(f, 'w1')
      const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, 'parse')
      if (parseDescriptor === undefined) throw new Error('expected JSON.parse')
      const handler: TaskHandler = async (_ctx, params) => params
      const reg = new Proxy(registry({ job: handler }), {
        get(_target, property) {
          if (property !== 'get') return undefined
          return () => {
            Object.defineProperty(JSON, 'parse', {
              configurable: true,
              value: () => ({ forged: true }),
              writable: true,
            })
            return handler
          }
        },
      })
      let observed: { value?: unknown; error?: unknown }
      try {
        observed = await runClaimedRun(
          { store: f.store, clock: f.clock, registry: reg },
          invocation,
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      } finally {
        Object.defineProperty(JSON, 'parse', parseDescriptor)
      }
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(
        { observed, result },
        'mutation-verdict:construction:sdk-worker-captured-json-parse',
      ).toEqual({
        observed: { value: { kind: 'completed' } },
        result: { state: 'completed', completedPayloadJson: '{"real":true}' },
      })
    } finally {
      f.close()
    }
  })

  it('a handler cannot replace heartbeat shutdown', async () => {
    const f = await fx('sdk-captured-abort-method')
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const observed = await replacePropertyAsync(
        AbortController.prototype,
        'abort',
        () => {
          throw new Error('task-installed abort ran')
        },
        () =>
          runClaimedRun(
            {
              store: f.store,
              clock: f.clock,
              registry: registry({ job: async () => 'done' }),
            },
            invocation,
          ),
      )
      expect(observed, 'mutation-verdict:construction:sdk-captured-abort-method').toEqual({
        value: { kind: 'completed' },
      })
    } finally {
      f.close()
    }
  })

  it('task initialization cannot replace unknown-task jitter character reads', async () => {
    const f = await fx('sdk-captured-char-code')
    try {
      await f.store.spawn(Q, 'unknown', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const observed = await replacePropertyAsync(
        String.prototype,
        'charCodeAt',
        () => {
          throw new Error('task-installed charCodeAt ran')
        },
        () => runClaimedRun({ store: f.store, clock: f.clock, registry: registry({}) }, invocation),
      )
      expect(observed, 'mutation-verdict:construction:sdk-captured-char-code-at').toEqual({
        value: { kind: 'deferred' },
      })
    } finally {
      f.close()
    }
  })

  it('FatalTaskError skips remaining retries and fails terminally', async () => {
    const f = await fx('sdk-fatal')
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

  it('enumerates every task-throwable corpus case', () => {
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-plain-string',
    ).toContain('plain-string')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-plain-object',
    ).toContain('plain-object')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-type-error',
    ).toContain('type-error')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-revoked-proxy',
    ).toContain('revoked-proxy')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-throwing-name-getter',
    ).toContain('throwing-name-getter')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-throwing-message-getter',
    ).toContain('throwing-message-getter')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-throwing-coercion',
    ).toContain('throwing-coercion')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-constructed-suspend',
    ).toContain('constructed-suspend')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-constructed-lease-lost',
    ).toContain('constructed-lease-lost')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-constructed-store-unavailable',
    ).toContain('constructed-store-unavailable')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-forged-suspend',
    ).toContain('forged-suspend')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-forged-lease-lost',
    ).toContain('forged-lease-lost')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-forged-store-unavailable',
    ).toContain('forged-store-unavailable')
    expect(
      TASK_THROWABLE_CASE_IDS,
      'mutation-verdict:construction:task-throwable-corpus-forged-fatal',
    ).toContain('forged-fatal')
    expect(Object.keys(TASK_THROWABLE_CASES).sort()).toEqual([...TASK_THROWABLE_CASE_IDS].sort())
  })

  for (const caseId of TASK_THROWABLE_CASE_IDS) {
    const thrown = TASK_THROWABLE_CASES[caseId]
    it(`records a ${thrown.name} throw through the user failure policy`, async () => {
      const f = await fx(`sdk-task-throw-${caseId}`)
      try {
        const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 2 })
        const reg = registry({
          job: async () => {
            throw thrown.makeValue()
          },
        })
        const first = await claimAndRun(f, reg, 'w1')
        await f.advance(10_000)
        const second = await claimAndRun(f, reg, 'w2')
        const result = await f.store.getTaskResult(Q, spawned.taskId)
        const [task, runs] = await f.raw.batch(
          'hostile-throw-result',
          [
            {
              sql: `SELECT state, attempts, infra_retries FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
            {
              sql: `SELECT attempt, state, claimed_by FROM runs
                    WHERE task_id = ? ORDER BY attempt`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )

        expect({ first, second, result, task: task?.rows[0], runs: runs?.rows }).toEqual({
          first: { kind: 'retry-scheduled' },
          second: { kind: 'failed' },
          result: { state: 'failed', failureReasonJson: thrown.failureJson },
          task: { state: 'failed', attempts: 2, infra_retries: 0 },
          runs: [
            { attempt: 1, state: 'failed', claimed_by: null },
            { attempt: 2, state: 'failed', claimed_by: null },
          ],
        })
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      } finally {
        f.close()
      }
    })
  }

  it('snapshots the raw handler throw exactly once at the worker boundary', async () => {
    const f = await fx('sdk-task-throw-boundary')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
      expect(
        await claimAndRun(
          f,
          registry({
            job: async () => {
              throw new Error('worker boundary original')
            },
          }),
          'w1',
        ),
      ).toEqual({ kind: 'failed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(
        result?.failureReasonJson,
        'mutation-verdict:behavior:sdk-task-throwable-boundary',
      ).toBe('{"name":"Error","message":"worker boundary original"}')
    } finally {
      f.close()
    }
  })

  for (const boundary of ['step result', 'handler result'] as const) {
    for (const [valueName, makeValue] of NON_SERIALIZABLE_VALUES) {
      it(`fails a non-serializable ${valueName} ${boundary} permanently`, async () => {
        const f = await fx(
          `sdk-non-serializable-${boundary.replaceAll(' ', '-')}-${valueName.replaceAll(' ', '-')}`,
        )
        try {
          let executions = 0
          const handler: TaskHandler =
            boundary === 'step result'
              ? async (ctx) =>
                  ctx.step('not-json', () => {
                    executions++
                    return makeValue()
                  })
              : async () => {
                  executions++
                  return makeValue()
                }
          const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })

          const outcome = await claimAndRun(f, registry({ job: handler }), 'w1')
          const [task] = await f.raw.batch(
            'probe',
            [
              {
                sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`,
                args: [spawned.taskId],
              },
            ],
            'read',
          )
          const [runs] = await f.raw.batch(
            'probe',
            [
              {
                sql: `SELECT state FROM runs WHERE task_id = ? ORDER BY attempt`,
                args: [spawned.taskId],
              },
            ],
            'read',
          )

          expect({
            outcome,
            executions,
            task: task?.rows[0],
            runStates: runs?.rows.map((row) => row.state),
          }).toEqual({
            outcome: { kind: 'failed' },
            executions: 1,
            task: { state: 'failed', attempts: 1 },
            runStates: ['failed'],
          })
        } finally {
          f.close()
        }
      })
    }
  }

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

  it('a handler cannot replace context lease-loss signal classification', async () => {
    const f = await fx('sdk-context-captured-aborted')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const reg = registry({
        job: async (ctx) => {
          const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')
          if (descriptor === undefined) throw new Error('expected AbortSignal.aborted')
          Object.defineProperty(AbortSignal.prototype, 'aborted', {
            configurable: true,
            get: () => true,
          })
          try {
            return await ctx.step('value', () => ({ real: true }))
          } finally {
            Object.defineProperty(AbortSignal.prototype, 'aborted', descriptor)
          }
        },
      })
      expect(await claimAndRun(f, reg, 'w1')).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(result, 'mutation-verdict:behavior:sdk-context-captured-aborted-getter').toEqual({
        state: 'completed',
        completedPayloadJson: '{"real":true}',
      })
    } finally {
      f.close()
    }
  })

  it('a handler cannot replace promise adoption during worker finalization', async () => {
    const f = await fx('sdk-finalize-captured-promise-adoption')
    const descriptor = Object.getOwnPropertyDescriptor(Promise, 'resolve')
    if (descriptor === undefined) throw new Error('expected Promise.resolve')
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      let observed: { value?: unknown; error?: unknown }
      try {
        observed = await runClaimedRun(
          {
            store: f.store,
            clock: f.clock,
            registry: registry({
              job: async () => {
                Object.defineProperty(Promise, 'resolve', {
                  configurable: true,
                  value: () => Promise.reject(new Error('task-installed Promise.resolve ran')),
                  writable: true,
                })
                return 'done'
              },
            }),
          },
          invocation,
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      } finally {
        Object.defineProperty(Promise, 'resolve', descriptor)
      }
      expect(observed, 'mutation-verdict:behavior:sdk-captured-promise-adoption').toEqual({
        value: { kind: 'completed' },
      })
    } finally {
      Object.defineProperty(Promise, 'resolve', descriptor)
      f.close()
    }
  })

  it('uses stored Map entries under subclass and prototype pollution', async () => {
    const f = await fx('sdk-captured-registry-get')
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      class RedirectingRegistry extends Map<string, TaskHandler> {
        override get(name: string): TaskHandler | undefined {
          return super.get(name === 'job' ? 'missing' : name)
        }
      }
      const reg = new RedirectingRegistry([['job', async () => 'done']])
      const observed = await replacePropertyAsync(
        Map.prototype,
        'get',
        () => undefined,
        () => runClaimedRun({ store: f.store, clock: f.clock, registry: reg }, invocation),
      )
      expect(observed, 'mutation-verdict:behavior:sdk-captured-registry-get').toEqual({
        value: { kind: 'completed' },
      })
    } finally {
      f.close()
    }
  })
})

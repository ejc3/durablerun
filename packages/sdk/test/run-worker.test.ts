import { engineInvariantViolations } from '@durablerun/conformance'
import {
  type Clock,
  FatalTaskError,
  LeaseLostError,
  type SchedulerStore,
  StoreUnavailableError,
  SuspendSignal,
  snapshotTaskThrowable,
} from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import {
  type TaskContext,
  type TaskHandler,
  type TaskRegistry,
  runClaimedRun,
} from '../src/index.js'
import {
  TaskAbortController,
  TaskMap,
  abortControllerSignal,
  abortSignalAborted,
  taskMapGet,
  taskMapSet,
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

const INVALID_CONTEXT_CALLS: readonly {
  readonly title: string
  readonly call: (ctx: TaskContext) => Promise<unknown>
}[] = [
  { title: "step name '#x'", call: (ctx) => ctx.step('#x', () => 1) },
  { title: "step name 'a#b'", call: (ctx) => ctx.step('a#b', () => 1) },
  { title: "step name '$x'", call: (ctx) => ctx.step('$x', () => 1) },
  { title: "awaitEvent name 'x#y'", call: (ctx) => ctx.awaitEvent('x#y') },
  { title: "awaitEvent name '$go'", call: (ctx) => ctx.awaitEvent('$go') },
  { title: "emitEvent name 'x#y'", call: (ctx) => ctx.emitEvent('x#y', '{}') },
  { title: "emitEvent name '$go'", call: (ctx) => ctx.emitEvent('$go', '{}') },
  {
    title: 'awaitEvent timeout NaN',
    call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: Number.NaN }),
  },
  { title: 'awaitEvent timeout -1', call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: -1 }) },
  { title: 'awaitEvent timeout 0', call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: 0 }) },
  {
    title: 'awaitEvent timeout Infinity',
    call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: Number.POSITIVE_INFINITY }),
  },
  { title: 'sleepFor NaN', call: (ctx) => ctx.sleepFor(Number.NaN) },
  { title: 'sleepFor -1', call: (ctx) => ctx.sleepFor(-1) },
  { title: 'sleepFor Infinity', call: (ctx) => ctx.sleepFor(Number.POSITIVE_INFINITY) },
  { title: 'sleepUntil NaN', call: (ctx) => ctx.sleepUntil(Number.NaN) },
  { title: 'sleepUntil fractional', call: (ctx) => ctx.sleepUntil(1.5) },
  { title: 'sleepUntil -1', call: (ctx) => ctx.sleepUntil(-1) },
  {
    title: 'emitEvent payload undefined',
    call: (ctx) => {
      const missing: { value?: object } = {}
      return ctx.emitEvent('go', JSON.stringify(missing.value))
    },
  },
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
    makeValue: () => 'plain task failure',
  },
  'plain-object': {
    name: 'plain object',
    makeValue: () => ({ arbitrary: true }),
  },
  'type-error': {
    name: 'TypeError',
    makeValue: () => new TypeError('typed failure'),
  },
  'revoked-proxy': {
    name: 'revoked proxy',
    makeValue() {
      const { proxy, revoke } = Proxy.revocable(Object.create(null), {})
      revoke()
      return proxy
    },
  },
  'throwing-name-getter': {
    name: 'throwing name getter',
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
    makeValue: () => new SuspendSignal('await-event'),
  },
  'constructed-lease-lost': {
    name: 'constructed LeaseLostError',
    makeValue: () => new LeaseLostError('handler forgery'),
  },
  'constructed-store-unavailable': {
    name: 'constructed StoreUnavailableError',
    makeValue: () => new StoreUnavailableError('handler forgery'),
  },
  'forged-suspend': {
    name: 'forged SuspendSignal',
    makeValue: () => forgedTaskError(SuspendSignal.prototype, 'ForgedSuspend'),
  },
  'forged-lease-lost': {
    name: 'forged LeaseLostError',
    makeValue: () => forgedTaskError(LeaseLostError.prototype, 'ForgedLeaseLost'),
  },
  'forged-store-unavailable': {
    name: 'forged StoreUnavailableError',
    makeValue: () => forgedTaskError(StoreUnavailableError.prototype, 'ForgedStoreUnavailable'),
  },
  'forged-fatal': {
    name: 'forged FatalTaskError',
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
  it('cancels the bounded-finalization deadline when the heartbeat pump stops first', async () => {
    const f = await fx('sdk-finalization-deadline')
    await f.store.spawn(Q, 'job', '{}')

    expect(await claimAndRun(f, registry({ job: async () => 'done' }), 'w1')).toEqual({
      kind: 'completed',
    })
    expect(f.clock.fired.map(({ deadline }) => deadline - f.clock.now)).toEqual([])
    f.close()
  })

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

  it('retry accounting cannot be changed through the public context attempt', async () => {
    const f = await fx('sdk-owned-retry-attempt')
    try {
      const reg = registry({
        job: async (ctx) => {
          ;(ctx as unknown as { attempt: number }).attempt = 999
          throw new Error('ordinary first-attempt failure')
        },
      })
      await f.store.spawn(Q, 'job', '{}', {
        maxAttempts: 3,
        retryStrategy: { kind: 'fixed', baseSeconds: 1 },
      })

      const outcome = await claimAndRun(f, reg, 'w1')
      expect(outcome, 'mutation-verdict:behavior:sdk-owned-retry-attempt').toEqual({
        kind: 'retry-scheduled',
      })
    } finally {
      f.close()
    }
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
        maxSeconds: 0,
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
          sql: `SELECT attempt, state
                FROM runs WHERE task_id = ? ORDER BY attempt`,
          args: [spawned.taskId],
        },
      ],
      'read',
    )
    expect(task?.rows[0]).toMatchObject({ state: 'pending', attempts: 1025 })
    expect(runs?.rows).toEqual([
      { attempt: 1025, state: 'failed' },
      { attempt: 1026, state: 'pending' },
    ])
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('protects every task-value JSON parse boundary with one captured capability', async () => {
    const f = await fx('sdk-captured-json-parse-boundaries')
    const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, 'parse')
    if (typeof parseDescriptor?.value !== 'function') {
      f.close()
      throw new Error('JSON.parse must be an own data property')
    }
    const authenticParse = parseDescriptor.value as (...args: unknown[]) => unknown
    try {
      const spawned = await f.store.spawn(Q, 'job', '{"param":"authentic"}', {
        retryStrategy: { kind: 'fixed', baseSeconds: 1 },
        headers: { trace: 'authentic' },
      })
      const observed = await replacePropertyAsync(
        JSON,
        'parse',
        (...args: unknown[]) => {
          const source = args[0]
          if (source === '{"kind":"fixed","baseSeconds":1}') return { kind: 'none' }
          if (source === '{"trace":"authentic"}') return { trace: 'forged' }
          if (source === '{"param":"authentic"}') return { param: 'forged' }
          if (source === '{"step":"authentic"}') return { step: 'forged' }
          return Reflect.apply(authenticParse, JSON, args)
        },
        async () => {
          const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
          if (!run) throw new Error('expected a claimable run')
          const outcome = await runClaimedRun(
            {
              store: f.store,
              clock: f.clock,
              registry: registry({
                job: async (ctx, params) => ({
                  params,
                  step: await ctx.step('value', () => ({ step: 'authentic' })),
                }),
              }),
            },
            { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
          )
          const result = await f.store.getTaskResult(Q, spawned.taskId)
          return {
            claim: { retryStrategy: run.retryStrategy, headers: run.headers },
            outcome,
            result,
          }
        },
      )
      expect(observed, 'mutation-verdict:construction:task-value-captured-parse').toEqual({
        value: {
          claim: {
            retryStrategy: { kind: 'fixed', baseSeconds: 1 },
            headers: { trace: 'authentic' },
          },
          outcome: { kind: 'completed' },
          result: {
            state: 'completed',
            completedPayloadJson: '{"params":{"param":"authentic"},"step":{"step":"authentic"}}',
          },
        },
      })
    } finally {
      f.close()
    }
  })

  it('owns task serialization and permanent-failure boundaries in one aggregate', async () => {
    const f = await fx('sdk-captured-json-stringify-boundaries')
    const stringifyDescriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify')
    if (typeof stringifyDescriptor?.value !== 'function') {
      f.close()
      throw new Error('JSON.stringify must be an own data property')
    }
    const authenticStringify = stringifyDescriptor.value as (...args: unknown[]) => unknown
    try {
      const observed = await replacePropertyAsync(
        JSON,
        'stringify',
        (...args: unknown[]) => {
          const candidate = args[0]
          if (typeof candidate === 'object' && candidate !== null) {
            if (
              Reflect.get(candidate, 'kind') === 'fixed' &&
              Reflect.get(candidate, 'baseSeconds') === 1.234
            ) {
              return '{"kind":"none"}'
            }
            if (
              Reflect.get(candidate, 'maxDelaySeconds') === 30 &&
              Reflect.get(candidate, 'maxDurationSeconds') === 60
            ) {
              return '{"maxDelaySeconds":999,"maxDurationSeconds":999}'
            }
            if (Reflect.get(candidate, 'trace') === 'authentic') {
              return '{"trace":"forged"}'
            }
            if (Reflect.get(candidate, 'inSeconds') === 10) {
              return '{"inSeconds":999}'
            }
            if (Reflect.get(candidate, 'real') === true) {
              return '{"forged":true}'
            }
          }
          return Reflect.apply(authenticStringify, JSON, args)
        },
        async () => {
          const spawned = await f.store.spawn(Q, 'job', '{}', {
            retryStrategy: { kind: 'fixed', baseSeconds: 1.234 },
            cancellation: { maxDelaySeconds: 30, maxDurationSeconds: 60 },
            headers: { trace: 'authentic' },
          })
          const [task] = await f.raw.batch(
            'captured-stringify-task',
            [
              {
                sql: `SELECT retry_strategy, cancellation, headers
                      FROM tasks WHERE task_id = ?`,
                args: [spawned.taskId],
              },
            ],
            'read',
          )
          const reg = registry({
            job: async (ctx) => {
              await ctx.sleepFor(10)
              return { real: true }
            },
          })
          const first = await claimAndRun(f, reg, 'w1')
          const [checkpoint] = await f.raw.batch(
            'captured-stringify-checkpoint',
            [
              {
                sql: `SELECT state FROM checkpoints
                      WHERE task_id = ? AND checkpoint_name = '$sleep'`,
                args: [spawned.taskId],
              },
            ],
            'read',
          )
          await f.advance(10_000)
          const second = await claimAndRun(f, reg, 'w2')
          const result = await f.store.getTaskResult(Q, spawned.taskId)
          return {
            task: task?.rows[0],
            first,
            checkpoint: checkpoint?.rows[0],
            second,
            result,
          }
        },
      )

      const inheritedToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
      let retryPrototype: unknown
      try {
        const strategy = {
          kind: 'fixed' as const,
          get baseSeconds(): number {
            Object.defineProperty(Object.prototype, 'toJSON', {
              configurable: true,
              enumerable: false,
              writable: true,
              value(this: unknown): unknown {
                if (
                  typeof this === 'object' &&
                  this !== null &&
                  Object.isFrozen(this) &&
                  Reflect.get(this, 'kind') === 'fixed' &&
                  Reflect.get(this, 'baseSeconds') === 1.234
                ) {
                  return { kind: 'none' }
                }
                return this
              },
            })
            return 1.234
          },
        }
        let pending!: ReturnType<LibsqlSchedulerStore['spawn']>
        try {
          pending = f.store.spawn(Q, 'prototype-retry', '{}', { retryStrategy: strategy })
        } finally {
          if (inheritedToJson === undefined) {
            Reflect.deleteProperty(Object.prototype, 'toJSON')
          } else {
            Object.defineProperty(Object.prototype, 'toJSON', inheritedToJson)
          }
        }
        const spawned = await pending
        const [task] = await f.raw.batch(
          'captured-stringify-prototype-retry',
          [
            {
              sql: `SELECT retry_strategy FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )
        retryPrototype = task?.rows[0]?.retry_strategy
      } finally {
        if (inheritedToJson === undefined) {
          Reflect.deleteProperty(Object.prototype, 'toJSON')
        } else {
          Object.defineProperty(Object.prototype, 'toJSON', inheritedToJson)
        }
      }

      const handlerResults: unknown[] = []
      for (const [valueName, makeValue] of NON_SERIALIZABLE_VALUES) {
        const resultFixture = await fx(
          `sdk-stringify-handler-result-${valueName.replaceAll(' ', '-')}`,
        )
        try {
          let executions = 0
          const spawned = await resultFixture.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
          const settled = await claimAndRun(
            resultFixture,
            registry({
              job: async () => {
                executions++
                return makeValue()
              },
            }),
            'w1',
          ).then(
            (value) => ({ kind: 'resolved' as const, value }),
            () => ({ kind: 'rejected' as const }),
          )
          const [task, runs] = await resultFixture.raw.batch(
            'captured-stringify-handler-result',
            [
              {
                sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`,
                args: [spawned.taskId],
              },
              {
                sql: `SELECT state FROM runs WHERE task_id = ? ORDER BY attempt`,
                args: [spawned.taskId],
              },
            ],
            'read',
          )
          handlerResults.push({
            valueName,
            settled,
            executions,
            task: task?.rows[0],
            runStates: runs?.rows.map((row) => row.state),
          })
        } finally {
          resultFixture.close()
        }
      }

      const fatal = new FatalTaskError('fatal original')
      Object.defineProperty(fatal, 'message', { value: 'mutated after construction' })
      const fatalSnapshot = snapshotTaskThrowable(fatal)
      const fatalObservation = {
        snapshot: fatalSnapshot,
        frozen: Object.isFrozen(fatalSnapshot),
      }

      const permanentCases: { readonly title: string; readonly handler: TaskHandler }[] = [
        {
          title: 'explicit FatalTaskError',
          handler: async () => {
            throw new FatalTaskError('unrecoverable input')
          },
        },
        ...NON_SERIALIZABLE_VALUES.map(([valueName, makeValue]) => ({
          title: `step result ${valueName}`,
          handler: async (ctx: TaskContext) => ctx.step('not-json', () => makeValue()),
        })),
        {
          title: 'durable operation nested inside a step',
          handler: async (ctx) =>
            ctx.step('outer', () => ctx.awaitEvent('go', { timeoutSeconds: 30 })),
        },
        ...INVALID_CONTEXT_CALLS.map(({ title, call }) => ({
          title: `invalid context input: ${title}`,
          handler: async (ctx: TaskContext) => call(ctx),
        })),
      ]
      const permanentResults: unknown[] = []
      for (const { title, handler } of permanentCases) {
        const permanentFixture = await fx(
          `sdk-fatal-policy-${title.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`,
        )
        try {
          let executions = 0
          const spawned = await permanentFixture.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
          const settled = await claimAndRun(
            permanentFixture,
            registry({
              job: async (ctx, params) => {
                executions++
                return handler(ctx, params)
              },
            }),
            'w1',
          ).then(
            (value) => ({ kind: 'resolved' as const, value }),
            () => ({ kind: 'rejected' as const }),
          )
          const [task, runs] = await permanentFixture.raw.batch(
            'fatal-policy-result',
            [
              {
                sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`,
                args: [spawned.taskId],
              },
              {
                sql: `SELECT state FROM runs WHERE task_id = ? ORDER BY attempt`,
                args: [spawned.taskId],
              },
            ],
            'read',
          )
          const invariantViolations = await engineInvariantViolations(permanentFixture.raw)
          permanentResults.push({
            title,
            settled,
            executions,
            task: task?.rows[0],
            runStates: runs?.rows.map((row) => row.state),
            invariantViolations,
          })
        } finally {
          permanentFixture.close()
        }
      }

      const rawErrorFixture = await fx('sdk-task-throw-boundary')
      let rawErrorObservation: unknown
      try {
        let executions = 0
        const spawned = await rawErrorFixture.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
        const settled = await claimAndRun(
          rawErrorFixture,
          registry({
            job: async () => {
              executions++
              throw new Error('worker boundary original')
            },
          }),
          'w1',
        ).then(
          (value) => ({ kind: 'resolved' as const, value }),
          () => ({ kind: 'rejected' as const }),
        )
        const result = await rawErrorFixture.store.getTaskResult(Q, spawned.taskId)
        const [task, runs] = await rawErrorFixture.raw.batch(
          'task-throw-boundary-result',
          [
            {
              sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
            {
              sql: `SELECT state FROM runs WHERE task_id = ? ORDER BY attempt`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )
        rawErrorObservation = {
          settled,
          executions,
          result,
          task: task?.rows[0],
          runStates: runs?.rows.map((row) => row.state),
          invariantViolations: await engineInvariantViolations(rawErrorFixture.raw),
        }
      } finally {
        rawErrorFixture.close()
      }

      expect(
        {
          observed,
          retryPrototype,
          handlerResults,
          fatalObservation,
          permanentResults,
          rawErrorObservation,
        },
        'mutation-verdict:behavior:task-boundary-aggregate',
      ).toEqual({
        observed: {
          value: {
            task: {
              retry_strategy: '{"kind":"fixed","baseSeconds":1.234}',
              cancellation: '{"maxDelaySeconds":30,"maxDurationSeconds":60}',
              headers: '{"trace":"authentic"}',
            },
            first: { kind: 'suspended' },
            checkpoint: { state: '{"inSeconds":10}' },
            second: { kind: 'completed' },
            result: { state: 'completed', completedPayloadJson: '{"real":true}' },
          },
        },
        retryPrototype: '{"kind":"fixed","baseSeconds":1.234}',
        handlerResults: NON_SERIALIZABLE_VALUES.map(([valueName]) => ({
          valueName,
          settled: { kind: 'resolved', value: { kind: 'failed' } },
          executions: 1,
          task: { state: 'failed', attempts: 1 },
          runStates: ['failed'],
        })),
        fatalObservation: {
          snapshot: {
            kind: 'failure',
            fatal: true,
            failureJson: '{"name":"FatalTaskError","message":"fatal original"}',
          },
          frozen: true,
        },
        permanentResults: permanentCases.map(({ title }) => ({
          title,
          settled: { kind: 'resolved', value: { kind: 'failed' } },
          executions: 1,
          task: { state: 'failed', attempts: 1 },
          runStates: ['failed'],
          invariantViolations: [],
        })),
        rawErrorObservation: {
          settled: { kind: 'resolved', value: { kind: 'failed' } },
          executions: 1,
          result: {
            state: 'failed',
            failureReasonJson: '{"name":"Error","message":"worker boundary original"}',
          },
          task: { state: 'failed', attempts: 1 },
          runStates: ['failed'],
          invariantViolations: [],
        },
      })
    } finally {
      f.close()
    }
  })

  it('propagates an ordinary completion rejection without billing it as a user failure', async () => {
    const f = await fx('sdk-complete-ordinary-rejection')
    const rejection = new Error('ordinary completion rejection')
    let failCalls = 0
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const store = new Proxy(f.store, {
        get(target, property, receiver) {
          if (property === 'complete') return () => Promise.reject(rejection)
          if (property === 'fail') {
            return () => {
              failCalls++
              return Promise.resolve()
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? (value as CallableFunction).bind(target) : value
        },
      })
      const observed = await runClaimedRun(
        {
          store,
          clock: f.clock,
          registry: registry({ job: async () => 'done' }),
        },
        invocation,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      expect(
        { observed, failCalls },
        'mutation-verdict:behavior:sdk-complete-ordinary-rejection-identity',
      ).toEqual({ observed: { error: rejection }, failCalls: 0 })
    } finally {
      f.close()
    }
  })

  it('reads an awaitEvent timeout accessor once and stores that validated value', async () => {
    const f = await fx('sdk-await-timeout-single-read')
    let timeoutReads = 0
    let storedTimeout: unknown
    try {
      await f.store.spawn(Q, 'job', '{}')
      const invocation = await claimInvocation(f, 'w1')
      const store = new Proxy(f.store, {
        get(target, property, receiver) {
          if (property === 'awaitEvent') {
            return (...args: unknown[]) => {
              storedTimeout = args[6]
              return Promise.resolve({ emitted: true, payloadJson: '{"ok":true}' })
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? (value as CallableFunction).bind(target) : value
        },
      })
      const opts = {
        get timeoutSeconds(): number {
          timeoutReads++
          return timeoutReads === 1 ? 30 : 90
        },
      }
      const outcome = await runClaimedRun(
        {
          store,
          clock: f.clock,
          registry: registry({ job: async (ctx) => ctx.awaitEvent('go', opts) }),
        },
        invocation,
      )
      expect(
        { timeoutReads, storedTimeout, outcome },
        'mutation-verdict:behavior:sdk-await-timeout-single-read',
      ).toEqual({ timeoutReads: 1, storedTimeout: 30, outcome: { kind: 'completed' } })
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
    const selected = new TaskMap<string, unknown>([['value', { real: true }]])
    Object.defineProperty(selected, 'cause', { value: new Error('map-get sentinel cause') })
    const control = new TaskMap<string, unknown>([['value', { real: true }]])
    const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'get')
    if (descriptor === undefined) throw new Error('expected Map.get')
    Object.defineProperty(Map.prototype, 'get', {
      configurable: true,
      value: () => ({ forged: true }),
      writable: true,
    })
    let observed: unknown
    try {
      observed = {
        selected: taskMapGet(selected, 'value'),
        control: taskMapGet(control, 'value'),
      }
    } finally {
      Object.defineProperty(Map.prototype, 'get', descriptor)
    }
    expect(observed, 'mutation-verdict:construction:sdk-captured-map-get').toEqual({
      selected: { real: true },
      control: { real: true },
    })
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

  it('a handler cannot replace bounded worker finalization', async () => {
    const runCase = async (ownFinalizationCause: boolean) => {
      const f = await fx('sdk-captured-promise-race')
      try {
        const sleep = f.clock.sleep.bind(f.clock)
        f.clock.sleep = (ms, interrupt) => {
          const pending = sleep(ms, interrupt)
          if (ownFinalizationCause && ms === 5_000) {
            Object.defineProperty(pending, 'cause', {
              value: new Error('finalization sentinel cause'),
            })
          }
          return pending
        }
        await f.store.spawn(Q, 'job', '{}')
        const invocation = await claimInvocation(f, 'w1')
        return await replacePropertyAsync(
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
      } finally {
        f.close()
      }
    }

    const observed = {
      selected: await runCase(true),
      control: await runCase(false),
    }
    expect(observed, 'mutation-verdict:construction:sdk-captured-promise-race').toEqual({
      selected: { value: { kind: 'completed' } },
      control: { value: { kind: 'completed' } },
    })
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
    const selected = abortControllerSignal(new TaskAbortController())
    Object.defineProperty(selected, 'cause', {
      value: new Error('abort-signal sentinel cause'),
    })
    const control = abortControllerSignal(new TaskAbortController())
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')
    if (descriptor === undefined) throw new Error('expected AbortSignal.aborted')
    Object.defineProperty(AbortSignal.prototype, 'aborted', {
      configurable: true,
      get: () => true,
    })
    let observed: { selected: boolean; control: boolean } | undefined
    try {
      observed = {
        selected: abortSignalAborted(selected),
        control: abortSignalAborted(control),
      }
    } finally {
      Object.defineProperty(AbortSignal.prototype, 'aborted', descriptor)
    }
    expect(observed, 'mutation-verdict:construction:sdk-captured-abort-aborted-getter').toEqual({
      selected: false,
      control: false,
    })
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

        expect({
          first,
          second,
          resultState: result?.state,
          task: task?.rows[0],
          runs: runs?.rows,
        }).toEqual({
          first: { kind: 'retry-scheduled' },
          second: { kind: 'failed' },
          resultState: 'failed',
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

  it('stops the heartbeat pump when checkpoint replay construction rejects', async () => {
    const f = await fx('sdk-malformed-checkpoint-pump')
    let beats = 0
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      if (spawned.runId === null) throw new Error('expected an initial run')
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('claim')
      await f.raw.batch('malformed-checkpoint', [
        {
          sql: `INSERT INTO checkpoints
                  (task_id, checkpoint_name, queue, state, status,
                   owner_run_id, owner_attempt, updated_at_ms)
                VALUES (?, 'broken', ?, '{', 'committed', ?, ?, ?)`,
          args: [spawned.taskId, Q, run.runId, run.attempt, f.clock.now],
        },
      ])
      const counting = new Proxy(f.store, {
        get(target, prop, receiver) {
          if (prop === 'heartbeat') {
            return async (..._args: Parameters<SchedulerStore['heartbeat']>) => {
              beats++
              // End the leaked pump after observing the one call, so the red
              // test itself leaves no live upkeep loop behind.
              return { held: false, remainingMs: 0 }
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })

      let rejected: unknown
      try {
        await runClaimedRun(
          {
            store: counting as SchedulerStore,
            clock: f.clock,
            registry: registry({ job: async () => null }),
          },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        )
      } catch (error) {
        rejected = error
      }
      expect(rejected).toBeInstanceOf(SyntaxError)

      await f.advance(30_000)
      await f.clock.yieldTurn()
      expect(beats, 'mutation-verdict:behavior:sdk-malformed-checkpoint-stops-pump').toBe(0)
    } finally {
      f.close()
    }
  })

  it('schedules upkeep before a legal sub-second lease expires', async () => {
    const f = await fx('sdk-subsecond-lease-upkeep')
    let releaseHandler: (() => void) | undefined
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    try {
      await f.store.spawn(Q, 'job', '{}')
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 0.001, limit: 1 })
      if (!run) throw new Error('claim')
      const pass = runClaimedRun(
        {
          store: f.store,
          clock: f.clock,
          registry: registry({
            job: async () => {
              await handlerBlocked
              return 'done'
            },
          }),
        },
        { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
      )

      while (f.clock.fired.length < 1) {
        await f.clock.yieldTurn()
      }
      const firstUpkeepDelay =
        (f.clock.fired[0]?.deadline ?? Number.POSITIVE_INFINITY) - f.clock.now
      releaseHandler?.()
      expect(await pass).toEqual({ kind: 'completed' })
      expect(
        firstUpkeepDelay,
        'mutation-verdict:behavior:sdk-subsecond-lease-upkeep-before-expiry',
      ).toBeLessThan(1)
    } finally {
      releaseHandler?.()
      f.close()
    }
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
      expect(
        await claimAndRun(f, reg, 'w1'),
        'mutation-verdict:behavior:sdk-context-captured-aborted-getter',
      ).toEqual({ kind: 'completed' })
      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(result).toEqual({
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
      await f.store.spawn(Q, 'job', '{}')
      const selectedInvocation = await claimInvocation(f, 'w1')
      const controlInvocation = await claimInvocation(f, 'w2')
      class RedirectingRegistry extends Map<string, TaskHandler> {
        override get(name: string): TaskHandler | undefined {
          return super.get(name === 'job' ? 'missing' : name)
        }
      }
      const handler: TaskHandler = async () => 'done'
      const selectedRegistry = new RedirectingRegistry([['job', handler]])
      Object.defineProperty(selectedRegistry, 'cause', {
        value: new Error('registry-get sentinel cause'),
      })
      const controlRegistry = new RedirectingRegistry([['job', handler]])
      const observed = await replacePropertyAsync(
        Map.prototype,
        'get',
        () => undefined,
        async () => ({
          selected: await runClaimedRun(
            { store: f.store, clock: f.clock, registry: selectedRegistry },
            selectedInvocation,
          ),
          control: await runClaimedRun(
            { store: f.store, clock: f.clock, registry: controlRegistry },
            controlInvocation,
          ),
        }),
      )
      expect(observed, 'mutation-verdict:behavior:sdk-captured-registry-get').toEqual({
        value: {
          selected: { kind: 'completed' },
          control: { kind: 'completed' },
        },
      })
    } finally {
      f.close()
    }
  })
})

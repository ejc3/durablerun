import {
  type Clock,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  type SchedulerStore,
  parseTaskValueJson,
  systemClock,
} from '@durablerun/core'
import type { TaskRegistry } from '@durablerun/sdk'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  HOSTED_REQUEST_BODY_MAX_BYTES,
  type HostedAuthorizationFacts,
  type HostedAuthorizationPlugin,
  type WakeRequest,
  type WakeScheduler,
  allowAuthorization,
  createHostedRouter,
  denyAuthorization,
} from '../src/index.js'

const Q = 'hosted-alpha'

function request(path: string, method: string, body?: string): Request {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = body
    init.headers = { 'content-type': 'application/json' }
  }
  return new Request(`https://alpha.example${path}`, init)
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json()
}

function recordingStore(source: SchedulerStore, calls: string[]): SchedulerStore {
  return new Proxy(source, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(property))
        return Reflect.apply(value, target, args)
      }
    },
  })
}

async function fixture(
  seed: string,
  options: {
    registry?: TaskRegistry
    authorization?: HostedAuthorizationPlugin
    onWorkAvailable?: () => void | Promise<void>
    scheduleWake?: WakeScheduler
    recordStoreCalls?: string[]
  } = {},
) {
  const { raw, admin, ids, close } = await openTestDb({ idNamespace: seed })
  await admin.setFakeNowEpochMs(1_000_000)
  const baseStore = new LibsqlSchedulerStore(raw, ids)
  const store =
    options.recordStoreCalls === undefined
      ? baseStore
      : recordingStore(baseStore, options.recordStoreCalls)
  const base = {
    store,
    ids,
    clock: systemClock() satisfies Clock,
    registry: options.registry ?? new Map(),
    authorization: options.authorization ?? (() => allowAuthorization()),
    queue: Q,
    sweepLimit: 10,
    leaseSeconds: 60,
  }
  const router = createHostedRouter({
    ...base,
    ...(options.onWorkAvailable === undefined ? {} : { onWorkAvailable: options.onWorkAvailable }),
    ...(options.scheduleWake === undefined ? {} : { scheduleWake: options.scheduleWake }),
  })
  return { raw, admin, store: baseStore, router, close }
}

function inspect(f: Awaited<ReturnType<typeof fixture>>, taskId: string): Promise<Response> {
  return f.router.handle(request(`/api/inspect?taskId=${encodeURIComponent(taskId)}`, 'GET'))
}

type HostedFixture = Awaited<ReturnType<typeof fixture>>

/** The status and the body of an inspect answer. */
async function inspected(f: HostedFixture, taskId: string) {
  const response = await inspect(f, taskId)
  return { status: response.status, body: await responseBody(response) }
}

/** Claim the queue's one claimable run, and activate it. */
async function claimed(f: HostedFixture, worker: string) {
  const [run] = await f.store.claim(Q, worker, { leaseSeconds: 60, limit: 1 })
  if (run === undefined) throw new Error(`nothing to claim for ${worker}`)
  await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
  return run
}

const SAGA_CAUSE = '{"name":"CardDeclined"}'

/** A task whose one registered step started, and whose failure placed a rollback pass. */
async function rollingBack(f: HostedFixture) {
  const spawned = await f.store.spawn(Q, 'saga', '{}')
  const forward = await claimed(f, 'forward')
  await f.store.setCheckpoint(
    Q,
    forward.taskId,
    forward.runId,
    forward.claimToken,
    `${SAGA_STARTED_PREFIX}charge`,
    '1',
    60,
  )
  await expect(
    f.store.fail(Q, forward.runId, forward.claimToken, SAGA_CAUSE, null),
  ).resolves.toEqual({ rollingBack: true })
  return { taskId: spawned.taskId, pass: await claimed(f, 'pass') }
}

/** The pass fails its rollback for good, and `errorJson` is the failure its attempt record holds. */
function haltRollback(
  f: HostedFixture,
  pass: { runId: string; claimToken: string },
  errorJson: string,
) {
  return f.store.failRollback(Q, pass.runId, pass.claimToken, SAGA_CAUSE, null, {
    stepKey: 'charge',
    errorJson,
  })
}

describe('hosted-alpha Web Request router', () => {
  it('rearms both HTTP and trusted ticks through sleep, completion, and idle', async () => {
    const wakes: WakeRequest[] = []
    const f = await fixture('hosted-wake-sleep', {
      scheduleWake: async (wake) => {
        wakes.push(wake)
      },
      registry: new Map([
        [
          'sleep',
          async (ctx) => {
            await ctx.sleepFor(1)
            return { done: true }
          },
        ],
      ]),
    })
    try {
      const spawned = await f.store.spawn(Q, 'sleep', '{}')
      const response = await f.router.handle(request('/api/tick', 'POST'))
      expect(response.status).toBe(200)
      expect(await f.store.getTaskResult(Q, spawned.taskId)).toMatchObject({ state: 'sleeping' })
      await f.router.runTick()
      expect(wakes).toEqual([
        { queue: Q, kind: 'immediate' },
        { queue: Q, kind: 'scheduled', atEpochMs: 1_001_000 },
      ])
      await f.admin.setFakeNowEpochMs(1_001_000)
      await f.router.runTick()
      expect(await f.store.getTaskResult(Q, spawned.taskId)).toMatchObject({ state: 'completed' })
      await f.router.runTick()
      expect(wakes).toEqual([
        { queue: Q, kind: 'immediate' },
        { queue: Q, kind: 'scheduled', atEpochMs: 1_001_000 },
        { queue: Q, kind: 'immediate' },
      ])
    } finally {
      f.close()
    }
  })

  it('returns 503 for a failed rearm without rolling back a completed task', async () => {
    const f = await fixture('hosted-wake-unavailable', {
      scheduleWake: async () => {
        throw new Error('private provider credential failure')
      },
      registry: new Map([['done', async () => ({ done: true })]]),
    })
    try {
      const spawned = await f.store.spawn(Q, 'done', '{}')
      const response = await f.router.handle(request('/api/tick', 'GET'))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'service_unavailable' })
      expect(await f.store.getTaskResult(Q, spawned.taskId)).toMatchObject({ state: 'completed' })
      // A redelivery sees idle and succeeds without executing the task again.
      const retried = await f.router.runTick()
      expect(retried.claimed).toBe(0)
      expect(retried.workerOutcome).toBeNull()
    } finally {
      f.close()
    }
  })

  it('does not invoke a wake plugin for unauthorized requests', async () => {
    const scheduleWake = vi.fn(async () => {})
    const f = await fixture('hosted-wake-denied', {
      scheduleWake,
      authorization: () => denyAuthorization('unauthenticated'),
    })
    try {
      expect((await f.router.handle(request('/api/tick', 'GET'))).status).toBe(401)
      expect(scheduleWake).not.toHaveBeenCalled()
    } finally {
      f.close()
    }
  })

  it('maps the four public routes exactly and returns canonical no-store JSON', async () => {
    const facts: HostedAuthorizationFacts[] = []
    const authorization: HostedAuthorizationPlugin = (snapshot) => {
      facts.push(snapshot)
      return allowAuthorization()
    }
    const handler = vi.fn(async (_ctx, params: unknown) => params)
    const f = await fixture('hosted-routes', {
      authorization,
      registry: new Map([['echo', handler]]),
    })
    try {
      const taskBody = '{\n  "taskName": "echo", "params": {"zero": -0}\n}'
      const spawnedResponse = await f.router.handle(request('/api/tasks', 'POST', taskBody))
      expect(spawnedResponse.status).toBe(201)
      expect(spawnedResponse.headers.get('cache-control')).toBe('no-store')
      const spawned = (await responseBody(spawnedResponse)) as {
        taskId: string
        runId: string
        created: boolean
      }
      expect(spawned).toMatchObject({ created: true })

      const eventBody = '{"eventName":"unrelated","payload":{"ok":true}}'
      const emitted = await f.router.handle(request('/api/events', 'POST', eventBody))
      expect(emitted.status).toBe(200)
      await expect(responseBody(emitted)).resolves.toEqual({ emitted: true })

      const ticked = await f.router.handle(request('/api/tick', 'GET'))
      expect(ticked.status).toBe(200)
      await expect(responseBody(ticked)).resolves.toMatchObject({
        claimed: 1,
        ended: 1,
        workerOutcome: { kind: 'completed' },
      })

      const inspected = await inspect(f, spawned.taskId)
      expect(inspected.status).toBe(200)
      await expect(responseBody(inspected)).resolves.toEqual({
        taskId: spawned.taskId,
        state: 'completed',
        result: { zero: 0 },
      })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(
        facts.map(({ operation, method, bodyText }) => ({ operation, method, bodyText })),
      ).toEqual([
        { operation: 'task.enqueue', method: 'POST', bodyText: taskBody },
        { operation: 'event.emit', method: 'POST', bodyText: eventBody },
        { operation: 'tick.run', method: 'GET', bodyText: '' },
        { operation: 'task.inspect', method: 'GET', bodyText: '' },
      ])
    } finally {
      f.close()
    }
  })

  it('returns the stored failure reason when inspecting a cancelled task', async () => {
    const f = await fixture('hosted-inspect-cancelled')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      await expect(f.store.cancelTask(Q, spawned.taskId)).resolves.toBe(true)

      const inspected = await inspect(f, spawned.taskId)
      expect(inspected.status).toBe(200)
      await expect(responseBody(inspected)).resolves.toEqual({
        taskId: spawned.taskId,
        state: 'cancelled',
        failure: { name: '$Cancelled' },
      })
    } finally {
      f.close()
    }
  })

  it('shows how the saga ended when inspecting a task that rolled back', async () => {
    const f = await fixture('hosted-inspect-rollback')
    try {
      const rolledBack = await rollingBack(f)
      await f.store.setCheckpoint(
        Q,
        rolledBack.taskId,
        rolledBack.pass.runId,
        rolledBack.pass.claimToken,
        `${SAGA_ROLLBACK_PREFIX}charge`,
        'null',
        60,
      )
      await f.store.fail(Q, rolledBack.pass.runId, rolledBack.pass.claimToken, SAGA_CAUSE, null)
      const halted = await rollingBack(f)
      await haltRollback(f, halted.pass, '{"name":"RefundDown"}')
      expect({
        rolledBack: await inspected(f, rolledBack.taskId),
        halted: await inspected(f, halted.taskId),
      }).toEqual({
        rolledBack: {
          status: 200,
          body: {
            taskId: rolledBack.taskId,
            state: 'failed',
            failure: { name: 'CardDeclined' },
            rollback: { outcome: 'complete' },
          },
        },
        halted: {
          status: 200,
          body: {
            taskId: halted.taskId,
            state: 'failed',
            failure: { name: 'CardDeclined' },
            rollback: { outcome: 'failed', error: { name: 'RefundDown' } },
          },
        },
      })
    } finally {
      f.close()
    }
  })

  // A store caller that is not the SDK can store text that is no JSON, and no value of a task
  // that ended ever changes. A route that throws on such a value answers 500 for that task
  // for good, so it answers with the text, under a key of its own.
  it('answers with the text of a rollback error that is not JSON', async () => {
    const f = await fixture('hosted-inspect-error-text')
    try {
      const halted = await rollingBack(f)
      await haltRollback(f, halted.pass, 'refund service down')
      expect(await inspected(f, halted.taskId)).toEqual({
        status: 200,
        body: {
          taskId: halted.taskId,
          state: 'failed',
          failure: { name: 'CardDeclined' },
          rollback: { outcome: 'failed', errorText: 'refund service down' },
        },
      })
    } finally {
      f.close()
    }
  })

  it('answers with the text of a failure reason that is not JSON', async () => {
    const f = await fixture('hosted-inspect-failure-text')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const run = await claimed(f, 'worker')
      await f.store.fail(Q, run.runId, run.claimToken, 'disk full', null)
      expect(await inspected(f, spawned.taskId)).toEqual({
        status: 200,
        body: { taskId: spawned.taskId, state: 'failed', failureText: 'disk full' },
      })
    } finally {
      f.close()
    }
  })

  it('answers with the text of a result that is not JSON', async () => {
    const f = await fixture('hosted-inspect-result-text')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const run = await claimed(f, 'worker')
      await f.store.complete(Q, run.runId, run.claimToken, 'done, mostly')
      expect(await inspected(f, spawned.taskId)).toEqual({
        status: 200,
        body: { taskId: spawned.taskId, state: 'completed', resultText: 'done, mostly' },
      })
    } finally {
      f.close()
    }
  })

  // A value can parse and still not serialize: JSON nested deeper than the serializer can
  // walk. The answer is then serialized with every stored value as its text, which always
  // serializes, so no value the port accepted makes the route throw.
  it('answers with the text of stored values that parse and cannot be serialized', async () => {
    const f = await fixture('hosted-inspect-unserializable')
    try {
      const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`
      const completed = await f.store.spawn(Q, 'job', '{}')
      const first = await claimed(f, 'first')
      await f.store.complete(Q, first.runId, first.claimToken, deep)
      const failed = await f.store.spawn(Q, 'job', '{}')
      const second = await claimed(f, 'second')
      await f.store.fail(Q, second.runId, second.claimToken, deep, null)
      const halted = await rollingBack(f)
      await haltRollback(f, halted.pass, deep)
      // The text is 200 KB, so an answer is compared with a label where it holds the text whole.
      const told = async (taskId: string): Promise<unknown> =>
        JSON.parse(JSON.stringify(await inspected(f, taskId)), (_key, value) =>
          value === deep ? 'the stored text, whole' : value,
        )
      expect({
        result: await told(completed.taskId),
        failure: await told(failed.taskId),
        error: await told(halted.taskId),
      }).toEqual({
        result: {
          status: 200,
          body: {
            taskId: completed.taskId,
            state: 'completed',
            resultText: 'the stored text, whole',
          },
        },
        failure: {
          status: 200,
          body: { taskId: failed.taskId, state: 'failed', failureText: 'the stored text, whole' },
        },
        error: {
          status: 200,
          body: {
            taskId: halted.taskId,
            state: 'failed',
            failureText: SAGA_CAUSE,
            rollback: { outcome: 'failed', errorText: 'the stored text, whole' },
          },
        },
      })
    } finally {
      f.close()
    }
  })

  it('authorizes the exact body before parsing or touching the store and hides failures', async () => {
    const privateCause = 'private identity backend detail'
    const cases: ReadonlyArray<{
      plugin: HostedAuthorizationPlugin
      status: number
      error: string
    }> = [
      { plugin: () => denyAuthorization(), status: 401, error: 'unauthenticated' },
      {
        plugin: () => denyAuthorization('forbidden'),
        status: 403,
        error: 'forbidden',
      },
      {
        plugin: (() => ({
          kind: 'deny',
          reason: 'indeterminate',
        })) as unknown as HostedAuthorizationPlugin,
        status: 500,
        error: 'authorization_invalid',
      },
      {
        plugin: () => {
          throw new Error(privateCause)
        },
        status: 503,
        error: 'authorization_unavailable',
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      const calls: string[] = []
      let seenBody: string | undefined
      const f = await fixture(`hosted-auth-${index}`, {
        authorization: (facts) => {
          seenBody = facts.bodyText
          return testCase.plugin(facts)
        },
        recordStoreCalls: calls,
      })
      try {
        const malformed = '{ definitely not json'
        const response = await f.router.handle(request('/api/tasks', 'POST', malformed))
        const responseCopy = response.clone()
        expect(response.status).toBe(testCase.status)
        expect(await responseBody(response)).toEqual({ error: testCase.error })
        expect(await responseCopy.text()).not.toContain(privateCause)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(seenBody).toBe(malformed)
        expect(calls).toEqual([])
      } finally {
        f.close()
      }
    }
  })

  it('rejects an idempotency key in the engine namespace, and enqueues nothing', async () => {
    const f = await fixture('hosted-reserved-key')
    try {
      const response = await f.router.handle(
        request(
          '/api/tasks',
          'POST',
          JSON.stringify({ taskName: 'evil', idempotencyKey: '$spawn:some-parent:$spawn:child' }),
        ),
      )
      const tick = await f.router.runTick()
      expect(
        { status: response.status, body: await responseBody(response), claimed: tick.claimed },
        'mutation-verdict:behavior:hosted-enqueue-refuses-reserved-key',
      ).toEqual({ status: 400, body: { error: 'invalid_request' }, claimed: 0 })
    } finally {
      f.close()
    }
  })

  it('rejects a storage-unstable task name before it selects a different registry handler', async () => {
    const admin = vi.fn(async () => 'privileged')
    const f = await fixture('hosted-task-name-binding', {
      registry: new Map([['admin', admin]]),
    })
    try {
      const submittedTaskName = 'admin\u0000suffix'
      const response = await f.router.handle(
        request('/api/tasks', 'POST', JSON.stringify({ taskName: submittedTaskName })),
      )
      const body = await responseBody(response)
      const tick = await f.router.runTick()

      expect({
        status: response.status,
        body,
        claimed: tick.claimed,
        workerOutcome: tick.workerOutcome,
        adminCalls: admin.mock.calls.length,
      }).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
        claimed: 0,
        workerOutcome: null,
        adminCalls: 0,
      })
    } finally {
      f.close()
    }
  })

  it('rejects unknown paths, wrong methods, and oversized bytes before auth or store work', async () => {
    const authorization = vi.fn(() => allowAuthorization())
    const calls: string[] = []
    const f = await fixture('hosted-routing-rejections', {
      authorization,
      recordStoreCalls: calls,
    })
    try {
      const wrongMethod = request('/api/inspect?taskId=t', 'POST', '{"ignored":true}')
      const methodResponse = await f.router.handle(wrongMethod)
      expect(methodResponse.status).toBe(405)
      expect(methodResponse.headers.get('allow')).toBe('GET')
      expect(wrongMethod.bodyUsed).toBe(false)

      const unknown = request('/api/unknown', 'POST', '{"ignored":true}')
      expect((await f.router.handle(unknown)).status).toBe(404)
      expect(unknown.bodyUsed).toBe(false)

      const overByteLimit = '☃'.repeat(Math.floor(HOSTED_REQUEST_BODY_MAX_BYTES / 3) + 1)
      const tooLarge = await f.router.handle(request('/api/tasks', 'POST', overByteLimit))
      expect(tooLarge.status).toBe(413)
      await expect(responseBody(tooLarge)).resolves.toEqual({ error: 'body_too_large' })

      expect(authorization).not.toHaveBeenCalled()
      expect(calls).toEqual([])
    } finally {
      f.close()
    }
  })

  it('drives trigger, event suspension, resume, and inspection through the hosted surface', async () => {
    const handler = vi.fn(async (ctx) => {
      const payloadJson = await ctx.awaitEvent('ready')
      return parseTaskValueJson(payloadJson)
    })
    const f = await fixture('hosted-event-flow', {
      registry: new Map([['wait-for-ready', handler]]),
    })
    try {
      const spawnedResponse = await f.router.handle(
        request('/api/tasks', 'POST', '{"taskName":"wait-for-ready","params":{"input":1}}'),
      )
      const { taskId } = (await responseBody(spawnedResponse)) as { taskId: string }

      const suspended = await f.router.handle(request('/api/tick', 'POST', 'wake-now'))
      await expect(responseBody(suspended)).resolves.toMatchObject({
        claimed: 1,
        workerOutcome: { kind: 'suspended' },
      })
      const sleeping = await inspect(f, taskId)
      await expect(responseBody(sleeping)).resolves.toEqual({ taskId, state: 'sleeping' })

      const emitted = await f.router.handle(
        request('/api/events', 'POST', '{"eventName":"ready","payload":{"answer":42}}'),
      )
      expect(emitted.status).toBe(200)
      const resumed = await f.router.handle(request('/api/tick', 'POST'))
      await expect(responseBody(resumed)).resolves.toMatchObject({
        claimed: 1,
        workerOutcome: { kind: 'completed' },
      })

      const completed = await inspect(f, taskId)
      await expect(responseBody(completed)).resolves.toEqual({
        taskId,
        state: 'completed',
        result: { answer: 42 },
      })
      expect(handler).toHaveBeenCalledTimes(2)
    } finally {
      f.close()
    }
  })

  it('keeps overlapping inline ticks to one execution of a claimed run', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: (() => void) | undefined
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const handler = vi.fn(async () => {
      started?.()
      await gate
      return 'done'
    })
    const f = await fixture('hosted-overlap', {
      registry: new Map([['one', handler]]),
    })
    try {
      await f.router.handle(request('/api/tasks', 'POST', '{"taskName":"one"}'))
      const first = f.router.handle(request('/api/tick', 'GET'))
      await workerStarted

      const overlap = await f.router.runTick()
      expect(overlap).toMatchObject({
        claimed: 0,
        workerOutcome: null,
      })
      expect(handler).toHaveBeenCalledTimes(1)

      release?.()
      await expect(responseBody(await first)).resolves.toMatchObject({
        claimed: 1,
        workerOutcome: { kind: 'completed' },
      })
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      release?.()
      f.close()
    }
  })

  it('treats the post-mutation wake hook as a lossy hint', async () => {
    let calls = 0
    const wake = vi.fn((): void | Promise<void> => {
      calls++
      if (calls === 1) throw new Error('synchronous wake failure')
      return Promise.reject(new Error('asynchronous wake failure'))
    })
    const f = await fixture('hosted-wake-hook', { onWorkAvailable: wake })
    try {
      const task = await f.router.handle(
        request('/api/tasks', 'POST', '{"taskName":"not-deployed-yet"}'),
      )
      expect(task.status).toBe(201)
      const emitted = await f.router.handle(
        request('/api/events', 'POST', '{"eventName":"later","payload":true}'),
      )
      expect(emitted.status).toBe(200)
      await Promise.resolve()
      expect(wake).toHaveBeenCalledTimes(2)
    } finally {
      f.close()
    }
  })
})

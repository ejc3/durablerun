import { type Clock, type SchedulerStore, parseTaskValueJson, systemClock } from '@durablerun/core'
import type { TaskRegistry } from '@durablerun/sdk'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  HOSTED_REQUEST_BODY_MAX_BYTES,
  type HostedAuthorizationFacts,
  type HostedAuthorizationPlugin,
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
  const router = createHostedRouter(
    options.onWorkAvailable === undefined
      ? base
      : { ...base, onWorkAvailable: options.onWorkAvailable },
  )
  return { raw, store: baseStore, router, close }
}

describe('hosted-alpha Web Request router', () => {
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

      const inspected = await f.router.handle(
        request(`/api/inspect?taskId=${encodeURIComponent(spawned.taskId)}`, 'GET'),
      )
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

      const inspected = await f.router.handle(
        request(`/api/inspect?taskId=${encodeURIComponent(spawned.taskId)}`, 'GET'),
      )
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
      const sleeping = await f.router.handle(
        request(`/api/inspect?taskId=${encodeURIComponent(taskId)}`, 'GET'),
      )
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

      const completed = await f.router.handle(
        request(`/api/inspect?taskId=${encodeURIComponent(taskId)}`, 'GET'),
      )
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

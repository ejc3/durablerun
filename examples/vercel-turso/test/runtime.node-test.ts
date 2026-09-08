import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serializeTaskValue, systemIdSource } from '@durablerun/core'
import type { WakeRequest } from '@durablerun/driver'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { hostedAuthorization } from '../src/auth.js'
import { requireHostedReceiptBaseUrl } from '../src/receipt.js'
import { createHostedExample } from '../src/runtime.js'
import {
  ATTEMPT_RECEIPT_TASK,
  RECEIPT_SLEEP_SECONDS,
  SLEEP_RECEIPT_TASK,
  WAIT_FOR_READY_TASK,
} from '../src/tasks.js'
import { WAKE_TOPIC, receiveVercelWake } from '../src/wake.js'

const API_TOKEN = 'example-api-token'
const CRON_TOKEN = 'example-cron-token'

test('external wiring refuses one credential for API and cron authority', () => {
  assert.throws(
    () => hostedAuthorization({ apiToken: API_TOKEN, cronToken: API_TOKEN }),
    new TypeError('hosted API and cron tokens must be distinct'),
  )
})

test('hosted receipt refuses a plaintext HTTP credential destination', () => {
  assert.throws(
    () => requireHostedReceiptBaseUrl('http://hosted.test'),
    new TypeError('DURABLERUN_BASE_URL must use HTTPS'),
  )
})

test('configuration installs the external app and gives its private queue a cron backstop', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    installCommand?: unknown
    crons?: unknown
    functions: Record<string, { experimentalTriggers?: unknown }>
  }
  assert.equal(config.installCommand, 'npm install')
  assert.deepEqual(config.crons, [{ path: '/api/tick', schedule: '* * * * *' }])
  assert.deepEqual(config.functions['api/wake.ts']?.experimentalTriggers, [
    { type: 'queue/v2beta', topic: WAKE_TOPIC, retryAfterSeconds: 5 },
  ])
})

test('the external scheduler resumes a sleeping task and stops when the queue is idle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'durablerun-hosted-example-'))
  const databaseUrl = `file:${join(directory, 'sleep.db')}`
  const raw = LibsqlExecutor.open(databaseUrl)
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  await admin.setFakeNowEpochMs(1_000_000)
  const queue = 'external-sleep-test'
  const wakes: WakeRequest[] = []
  const deferred: Promise<void>[] = []
  const runtime = createHostedExample({
    databaseUrl,
    databaseAuthToken: '',
    queue,
    authorization: hostedAuthorization({ apiToken: API_TOKEN, cronToken: CRON_TOKEN }),
    defer(work) {
      deferred.push(work)
    },
    async scheduleWake(wake) {
      wakes.push(wake)
    },
  })
  try {
    const response = await runtime.router.handle(
      request('/api/tasks', API_TOKEN, { taskName: SLEEP_RECEIPT_TASK }),
    )
    assert.equal(response.status, 201)
    const { taskId } = (await response.json()) as { taskId: string }
    await Promise.all(deferred)
    assert.deepEqual(wakes.splice(0), [{ queue, kind: 'immediate' }])
    await receiveVercelWake({ queue }, queue, runtime.router.runTick)
    assert.deepEqual(wakes, [
      { queue, kind: 'scheduled', atEpochMs: 1_000_000 + RECEIPT_SLEEP_SECONDS * 1_000 },
    ])
    wakes.length = 0
    await admin.setFakeNowEpochMs(1_000_000 + RECEIPT_SLEEP_SECONDS * 1_000)
    await receiveVercelWake({ queue }, queue, runtime.router.runTick)
    const completed = await runtime.router.handle(
      request(`/api/inspect?taskId=${encodeURIComponent(taskId)}`, API_TOKEN),
    )
    assert.deepEqual(await completed.json(), {
      taskId,
      state: 'completed',
      result: { sleptSeconds: RECEIPT_SLEEP_SECONDS, attempt: 1 },
    })
    assert.deepEqual(wakes.splice(0), [{ queue, kind: 'immediate' }])
    await receiveVercelWake({ queue }, queue, runtime.router.runTick)
    assert.deepEqual(wakes, [])
  } finally {
    raw.close()
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

function request(path: string, token?: string, body?: unknown): Request {
  const headers = new Headers()
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return new Request(`https://hosted.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('external wiring separates API and cron authority and resumes an event task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'durablerun-hosted-example-'))
  const databaseUrl = `file:${join(directory, 'event.db')}`
  const migration = LibsqlExecutor.open(databaseUrl)
  try {
    await new LibsqlStoreAdmin(migration).migrate()
  } finally {
    migration.close()
  }
  const deferred: Promise<void>[] = []
  const runtime = createHostedExample({
    databaseUrl,
    databaseAuthToken: '',
    queue: 'external-example-test',
    authorization: hostedAuthorization({ apiToken: API_TOKEN, cronToken: CRON_TOKEN }),
    defer(work) {
      deferred.push(work)
    },
  })
  try {
    assert.equal((await runtime.router.handle(request('/api/tick', API_TOKEN))).status, 401)
    assert.equal((await runtime.router.handle(request('/api/tasks'))).status, 405)

    const eventName = 'example-ready'
    const spawnedResponse = await runtime.router.handle(
      request('/api/tasks', API_TOKEN, {
        taskName: WAIT_FOR_READY_TASK,
        params: { eventName },
      }),
    )
    assert.equal(spawnedResponse.status, 201)
    const spawned = (await spawnedResponse.json()) as { taskId: string }
    await Promise.all(deferred.splice(0))

    const sleeping = await runtime.router.handle(
      request(`/api/inspect?taskId=${encodeURIComponent(spawned.taskId)}`, API_TOKEN),
    )
    assert.deepEqual(await sleeping.json(), { taskId: spawned.taskId, state: 'sleeping' })

    const emitResponse = await runtime.router.handle(
      request('/api/events', API_TOKEN, { eventName, payload: { answer: 42 } }),
    )
    assert.equal(emitResponse.status, 200)
    await Promise.all(deferred.splice(0))

    const completed = await runtime.router.handle(
      request(`/api/inspect?taskId=${encodeURIComponent(spawned.taskId)}`, API_TOKEN),
    )
    assert.deepEqual(await completed.json(), {
      taskId: spawned.taskId,
      state: 'completed',
      result: { eventName, payload: { answer: 42 } },
    })
    assert.equal((await runtime.router.handle(request('/api/tick', CRON_TOKEN))).status, 200)
  } finally {
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a claimed-but-unlaunched task is reopened without spending its user attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'durablerun-hosted-example-'))
  const databaseUrl = `file:${join(directory, 'receipt.db')}`
  const queue = 'external-lost-launch-test'
  const raw = LibsqlExecutor.open(databaseUrl)
  await new LibsqlStoreAdmin(raw).migrate()
  const runtime = createHostedExample({
    databaseUrl,
    databaseAuthToken: '',
    queue,
    authorization: hostedAuthorization({ apiToken: API_TOKEN, cronToken: CRON_TOKEN }),
  })
  try {
    const admin = new LibsqlStoreAdmin(raw)
    await admin.setFakeNowEpochMs(1_000_000)
    const ids = systemIdSource()
    const store = new LibsqlSchedulerStore(raw, ids)
    const spawned = await store.spawn(
      queue,
      ATTEMPT_RECEIPT_TASK,
      serializeTaskValue('attempt receipt parameters', null),
    )
    const claimed = await store.claim(queue, ids.token(), { leaseSeconds: 1, limit: 1 })
    assert.equal(claimed[0]?.taskId, spawned.taskId)

    await admin.setFakeNowEpochMs(1_001_001)
    const reopened = await runtime.router.runTick()
    assert.deepEqual(reopened.swept, [
      { kind: 'lost-launch', taskId: spawned.taskId, runId: spawned.runId, relaunchCount: 1 },
    ])

    await admin.setFakeNowEpochMs(1_007_001)
    const recovered = await runtime.router.runTick()
    assert.equal(recovered.workerOutcome?.kind, 'completed')
    const inspected = await runtime.router.handle(
      request(`/api/inspect?taskId=${encodeURIComponent(spawned.taskId)}`, API_TOKEN),
    )
    assert.deepEqual(await inspected.json(), {
      taskId: spawned.taskId,
      state: 'completed',
      result: { attempt: 1 },
    })
  } finally {
    raw.close()
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

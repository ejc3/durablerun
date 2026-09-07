import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serializeTaskValue, systemIdSource } from '@durablerun/core'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { hostedAuthorization } from '../src/auth.js'
import { createHostedExample } from '../src/runtime.js'
import { ATTEMPT_RECEIPT_TASK, WAIT_FOR_READY_TASK } from '../src/tasks.js'

const API_TOKEN = 'example-api-token'
const CRON_TOKEN = 'example-cron-token'

test('checked-in configuration overrides monorepo install and supports Vercel Hobby', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    installCommand?: unknown
    crons?: unknown
  }
  assert.equal(config.installCommand, 'npm install')
  assert.deepEqual(config.crons, [{ path: '/api/tick', schedule: '0 0 * * *' }])
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

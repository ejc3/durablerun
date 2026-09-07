import { randomUUID } from 'node:crypto'
import { serializeTaskValue, systemIdSource } from '@durablerun/core'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { ATTEMPT_RECEIPT_TASK, WAIT_FOR_READY_TASK } from '../src/tasks.js'

const RECEIPT_TIMEOUT_MS = 45_000
const REQUEST_TIMEOUT_MS = 10_000
const POLL_MS = 350

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set`)
  return value
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} did not return a JSON object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`response field ${key} is not a non-empty string`)
  }
  return field
}

const baseUrl = new URL(requiredEnv('DURABLERUN_BASE_URL'))
const apiToken = requiredEnv('DURABLERUN_API_TOKEN')
const cronToken = requiredEnv('CRON_SECRET')
const queue = requiredEnv('DURABLERUN_QUEUE')
const databaseUrl = requiredEnv('TURSO_DATABASE_URL')
const databaseAuthToken = requiredEnv('TURSO_AUTH_TOKEN')
const deadline = Date.now() + RECEIPT_TIMEOUT_MS

function remainingMs(): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`hosted receipt exceeded ${RECEIPT_TIMEOUT_MS}ms`)
  return remaining
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, remainingMs())))
}

async function call(
  path: string,
  options: {
    readonly method?: 'GET' | 'POST'
    readonly token?: string
    readonly body?: unknown
  } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers = new Headers()
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`)
  let body: string | undefined
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.body)
  }
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs())),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`)
  }
  return { status: response.status, body: parsed }
}

function expectStatus(
  result: { readonly status: number; readonly body: unknown },
  expected: number,
  what: string,
): void {
  if (result.status !== expected) {
    throw new Error(`${what}: expected HTTP ${expected}, got ${result.status}`)
  }
}

async function tick(): Promise<Record<string, unknown>> {
  const result = await call('/api/tick', { token: cronToken })
  expectStatus(result, 200, 'authorized tick')
  return object(result.body, 'tick')
}

async function inspect(taskId: string): Promise<Record<string, unknown>> {
  const result = await call(`/api/inspect?taskId=${encodeURIComponent(taskId)}`, {
    token: apiToken,
  })
  expectStatus(result, 200, `inspect ${taskId}`)
  return object(result.body, 'inspect')
}

async function driveTo(taskId: string, expectedState: 'sleeping' | 'completed') {
  for (;;) {
    await tick()
    const task = await inspect(taskId)
    const state = task.state
    if (state === expectedState) return task
    if (state === 'failed' || state === 'cancelled' || state === 'completed') {
      throw new Error(`task ${taskId} reached ${String(state)} while awaiting ${expectedState}`)
    }
    await pause()
  }
}

async function requireUnauthenticatedBoundaries(): Promise<void> {
  const probes = [
    call('/api/tasks', { method: 'POST', body: { taskName: WAIT_FOR_READY_TASK } }),
    call('/api/events', { method: 'POST', body: { eventName: 'receipt-probe' } }),
    call('/api/tick'),
    call('/api/inspect?taskId=receipt-probe'),
  ]
  for (const [index, result] of (await Promise.all(probes)).entries()) {
    expectStatus(result, 401, `unauthenticated boundary ${index + 1}`)
  }
}

function requireWaitResult(
  task: Record<string, unknown>,
  eventName: string,
  payload: unknown,
): void {
  const result = object(task.result, 'wait-for-ready result')
  if (
    result.eventName !== eventName ||
    JSON.stringify(result.payload) !== JSON.stringify(payload)
  ) {
    throw new Error('wait-for-ready result did not preserve the emitted event')
  }
}

function requireAttemptOne(task: Record<string, unknown>): void {
  const result = object(task.result, 'attempt receipt result')
  if (result.attempt !== 1) {
    throw new Error(`lost-launch recovery spent a user attempt: ${String(result.attempt)}`)
  }
}

await requireUnauthenticatedBoundaries()

const receiptId = randomUUID().replaceAll('-', '')
const eventName = `ready-${receiptId}`
const payload = { receiptId, answer: 42 }
const spawnedWait = await call('/api/tasks', {
  method: 'POST',
  token: apiToken,
  body: {
    taskName: WAIT_FOR_READY_TASK,
    params: { eventName },
    idempotencyKey: `hosted-wait-${receiptId}`,
  },
})
expectStatus(spawnedWait, 201, 'wait-for-ready enqueue')
const waitTaskId = stringField(object(spawnedWait.body, 'spawn'), 'taskId')
await driveTo(waitTaskId, 'sleeping')

const emitted = await call('/api/events', {
  method: 'POST',
  token: apiToken,
  body: { eventName, payload },
})
expectStatus(emitted, 200, 'event emit')
const completedWait = await driveTo(waitTaskId, 'completed')
requireWaitResult(completedWait, eventName, payload)

// Deliberately claim one freshly spawned run and discard its invocation. This
// is the only low-level part of the receipt; all recovery and observation use
// the deployed hosted endpoints.
const ids = systemIdSource()
const raw = LibsqlExecutor.open(databaseUrl, databaseAuthToken)
let attemptTaskId: string
try {
  await new LibsqlStoreAdmin(raw).migrate()
  const store = new LibsqlSchedulerStore(raw, ids)
  const spawnedAttempt = await store.spawn(
    queue,
    ATTEMPT_RECEIPT_TASK,
    serializeTaskValue('attempt receipt parameters', null),
    { idempotencyKey: `hosted-lost-launch-${receiptId}` },
  )
  if (!spawnedAttempt.created) throw new Error('lost-launch task unexpectedly already existed')
  attemptTaskId = spawnedAttempt.taskId
  const claimed = await store.claim(queue, ids.token(), { leaseSeconds: 1, limit: 1 })
  if (claimed.length !== 1 || claimed[0]?.taskId !== attemptTaskId) {
    throw new Error('receipt queue was not idle; use a dedicated hosted-alpha database and queue')
  }

  await pause()
  await pause()
  await pause()

  let relaunchCount = 0
  let completedAttempt: Record<string, unknown> | undefined
  for (;;) {
    const tickResult = await tick()
    const swept = Array.isArray(tickResult.swept) ? tickResult.swept : []
    for (const item of swept) {
      const entry = object(item, 'sweep entry')
      if (entry.taskId === attemptTaskId && entry.kind === 'lost-launch') {
        const count = entry.relaunchCount
        if (typeof count === 'number') relaunchCount = Math.max(relaunchCount, count)
      }
    }
    const [rows] = await raw.batch(
      'hosted-receipt:relaunch-count',
      [
        {
          sql: 'SELECT relaunch_count FROM runs WHERE queue = ? AND task_id = ?',
          args: [queue, attemptTaskId],
        },
      ],
      'read',
    )
    const stored = rows?.rows[0]?.relaunch_count
    if (typeof stored === 'number' || typeof stored === 'bigint') {
      relaunchCount = Math.max(relaunchCount, Number(stored))
    }
    const current = await inspect(attemptTaskId)
    if (current.state === 'completed') {
      completedAttempt = current
      break
    }
    if (current.state === 'failed' || current.state === 'cancelled') {
      throw new Error(`lost-launch task reached ${String(current.state)}`)
    }
    await pause()
  }
  if (relaunchCount !== 1) {
    throw new Error(`expected exactly one lost-launch reopen, got ${relaunchCount}`)
  }
  requireAttemptOne(completedAttempt)
} finally {
  raw.close()
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      authorization: 'all four boundaries rejected unauthenticated requests',
      eventWorkflow: { taskId: waitTaskId, state: 'completed' },
      lostLaunch: { taskId: attemptTaskId, relaunchCount: 1, attempt: 1 },
    },
    null,
    2,
  )}\n`,
)

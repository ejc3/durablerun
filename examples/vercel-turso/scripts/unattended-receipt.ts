import { randomUUID } from 'node:crypto'
import { serializeTaskValue, systemIdSource } from '@durablerun/core'
import { LibsqlExecutor, LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { requireHostedReceiptBaseUrl } from '../src/receipt.js'
import { RECEIPT_SLEEP_SECONDS, SLEEP_RECEIPT_TASK } from '../src/tasks.js'

const RECEIPT_TIMEOUT_MS = 240_000
const MAX_RESUME_LATENCY_MS = 60_000
const MAX_DROPPED_HINT_RECOVERY_MS = 120_000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set`)
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('receipt expected a JSON object')
  }
  return value as Record<string, unknown>
}

function epoch(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
    throw new Error('receipt expected a database epoch')
  }
  return result
}

const baseUrl = requireHostedReceiptBaseUrl(requiredEnv('DURABLERUN_BASE_URL'))
const apiToken = requiredEnv('DURABLERUN_API_TOKEN')
const queue = requiredEnv('DURABLERUN_QUEUE')
const deadline = Date.now() + RECEIPT_TIMEOUT_MS

function remainingMs(): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`unattended receipt exceeded ${RECEIPT_TIMEOUT_MS}ms`)
  return remaining
}

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, baseUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.min(10_000, remainingMs())),
  })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return object(await response.json())
}

// This probe is anonymous. In production the queue consumer is private and
// cannot be invoked through its public-looking path, even by an API caller.
const privateProbe = await fetch(new URL('/api/wake', baseUrl), {
  method: 'POST',
  body: JSON.stringify({ queue }),
  headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(Math.min(10_000, remainingMs())),
})
await privateProbe.body?.cancel()
if (![401, 403, 404].includes(privateProbe.status)) {
  throw new Error(`queue callback was not privately denied: HTTP ${privateProbe.status}`)
}

const raw = LibsqlExecutor.open(requiredEnv('TURSO_DATABASE_URL'), requiredEnv('TURSO_AUTH_TOKEN'))

async function runRow(taskId: string): Promise<Record<string, unknown>> {
  const [result] = await raw.batch(
    'unattended-receipt:run',
    [
      {
        sql: `SELECT state, available_at_ms, completed_at_ms, created_at_ms
              FROM runs WHERE queue = ? AND task_id = ? ORDER BY attempt DESC LIMIT 1`,
        args: [queue, taskId],
      },
    ],
    'read',
  )
  const row = result?.rows[0]
  if (row === undefined) throw new Error('receipt run is missing')
  return row
}

async function observeSleepThenComplete(taskId: string) {
  let dueAtEpochMs: number | undefined
  for (;;) {
    const task = await call(`/api/inspect?taskId=${encodeURIComponent(taskId)}`)
    if (task.state === 'sleeping' && dueAtEpochMs === undefined) {
      dueAtEpochMs = epoch((await runRow(taskId)).available_at_ms)
    }
    if (task.state === 'completed') {
      if (dueAtEpochMs === undefined) throw new Error('receipt never observed durable sleep')
      const result = object(task.result)
      if (result.sleptSeconds !== RECEIPT_SLEEP_SECONDS || result.attempt !== 1) {
        throw new Error('unattended workflow returned an unexpected result or attempt')
      }
      const row = await runRow(taskId)
      const completedAtEpochMs = epoch(row.completed_at_ms)
      const resumeLatencyMs = completedAtEpochMs - dueAtEpochMs
      if (resumeLatencyMs < 0 || resumeLatencyMs > MAX_RESUME_LATENCY_MS) {
        throw new Error(`unattended resume latency ${resumeLatencyMs}ms exceeded its bound`)
      }
      return {
        taskId,
        sleepingObserved: true,
        dueAtEpochMs,
        completedAtEpochMs,
        resumeLatencyMs,
        createdAtEpochMs: epoch(row.created_at_ms),
        attempt: 1,
      }
    }
    if (task.state === 'failed' || task.state === 'cancelled') {
      throw new Error(`unattended task reached ${String(task.state)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remainingMs())))
  }
}

try {
  const [live] = await raw.batch(
    'unattended-receipt:idle',
    [
      {
        sql: "SELECT COUNT(*) AS count FROM tasks WHERE queue = ? AND state IN ('pending', 'running', 'sleeping')",
        args: [queue],
      },
    ],
    'read',
  )
  if (Number(live?.rows[0]?.count) !== 0) {
    throw new Error('receipt requires an otherwise idle dedicated alpha queue')
  }

  const receiptId = randomUUID()
  // Commit directly and deliberately omit the producer's wake hint. This is
  // the state left when a producer dies immediately after a durable enqueue.
  // No local claim, tick, delayed timer, or other wake follows this write.
  const store = new LibsqlSchedulerStore(raw, systemIdSource())
  const spawnedWithoutHint = await store.spawn(
    queue,
    SLEEP_RECEIPT_TASK,
    serializeTaskValue('sleep receipt parameters', null),
    { idempotencyKey: `unattended-no-hint-${receiptId}` },
  )
  if (!spawnedWithoutHint.created) throw new Error('dropped-hint task unexpectedly existed')
  const droppedHint = await observeSleepThenComplete(spawnedWithoutHint.taskId)
  const recoveryLatencyMs = droppedHint.completedAtEpochMs - droppedHint.createdAtEpochMs
  if (recoveryLatencyMs > MAX_DROPPED_HINT_RECOVERY_MS) {
    throw new Error(`dropped-hint recovery took ${recoveryLatencyMs}ms`)
  }

  const spawned = await call('/api/tasks', {
    taskName: SLEEP_RECEIPT_TASK,
    idempotencyKey: `unattended-sleep-${receiptId}`,
  })
  if (typeof spawned.taskId !== 'string') throw new Error('enqueue returned no taskId')
  const scheduledSleep = await observeSleepThenComplete(spawned.taskId)

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        manualTicks: 0,
        privateCallbackStatus: privateProbe.status,
        scheduledSleep,
        droppedHint: { ...droppedHint, producerHintSent: false, recoveryLatencyMs },
        limits: {
          resumeLatencyMs: MAX_RESUME_LATENCY_MS,
          droppedHintRecoveryMs: MAX_DROPPED_HINT_RECOVERY_MS,
        },
      },
      null,
      2,
    )}\n`,
  )
} finally {
  raw.close()
}

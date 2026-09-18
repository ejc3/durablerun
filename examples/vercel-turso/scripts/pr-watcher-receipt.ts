import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  parseTaskValueJson,
  serializeTaskValue,
  systemClock,
  systemIdSource,
} from '@durablerun/core'
import { type RunInvocation, type TaskContext, runClaimedRun } from '@durablerun/sdk'
import { LibsqlExecutor, LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { observeGitHubChecks } from '../src/github-checks.js'
import {
  PR_WATCHER_OBSERVATION_STEP,
  PR_WATCHER_TASK,
  type PrWatchInput,
  createPrWatcher,
  parsePrWatchInput,
} from '../src/pr-watcher.js'
import { requireHostedReceiptBaseUrl } from '../src/receipt.js'

const RECEIPT_TIMEOUT_MS = 900_000
const CHILD_TIMEOUT_MS = 60_000
const INTERRUPTED_EXIT_CODE = 77

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set`)
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('receipt expected an object')
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`receipt expected a non-empty ${name}`)
  }
  return field
}

function integer(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new Error('receipt expected a non-negative database integer')
  }
  return number
}

function pendingObservation(value: unknown, input: PrWatchInput): boolean {
  const observation = object(value)
  return (
    observation.kind === 'observed' &&
    observation.headSha === input.headSha &&
    observation.state === 'open' &&
    Array.isArray(observation.checks) &&
    observation.checks.some((check) => object(check).state === 'pending') &&
    observation.checks.every((check) => ['passed', 'pending'].includes(String(object(check).state)))
  )
}

function openDatabase(): LibsqlExecutor {
  return LibsqlExecutor.open(requiredEnv('TURSO_DATABASE_URL'), requiredEnv('TURSO_AUTH_TOKEN'))
}

async function interruptedWorker(): Promise<void> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 4096) throw new Error('receipt invocation exceeds its bound')
    chunks.push(buffer)
  }
  const message = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const invocation: RunInvocation = {
    queue: stringField(message, 'queue'),
    runId: stringField(message, 'runId'),
    claimToken: stringField(message, 'claimToken'),
    claimGen: integer(message.claimGen),
  }
  if (invocation.queue !== requiredEnv('DURABLERUN_QUEUE') || invocation.claimGen === 0) {
    throw new Error('receipt invocation does not match its dedicated queue')
  }
  const raw = openDatabase()
  const store = new LibsqlSchedulerStore(raw, systemIdSource())
  const handler = createPrWatcher(observeGitHubChecks)
  try {
    await runClaimedRun(
      {
        store,
        clock: systemClock(),
        registry: new Map([
          [
            PR_WATCHER_TASK,
            async (ctx, params) => {
              const input = parsePrWatchInput(params)
              let firstObservation = true
              const interrupted: TaskContext = {
                attempt: ctx.attempt,
                taskName: ctx.taskName,
                async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
                  let executed = false
                  const result = await ctx.step(name, async () => {
                    executed = true
                    return await fn()
                  })
                  if (name === PR_WATCHER_OBSERVATION_STEP && firstObservation) {
                    firstObservation = false
                    // The real SDK has returned from its fenced checkpoint
                    // write. Death here cannot run its catch/finally or park.
                    // A terminal/unavailable observation is never crash proof.
                    if (executed && pendingObservation(result, input)) {
                      process.exit(INTERRUPTED_EXIT_CODE)
                    }
                  }
                  return result
                },
                sleepFor: ctx.sleepFor.bind(ctx),
                sleepUntil: ctx.sleepUntil.bind(ctx),
                awaitEvent: ctx.awaitEvent.bind(ctx),
                emitEvent: ctx.emitEvent.bind(ctx),
                spawn: ctx.spawn.bind(ctx),
                awaitTask: ctx.awaitTask.bind(ctx),
              }
              return handler(interrupted, params)
            },
          ],
        ]),
      },
      invocation,
    )
    // The observation raced to terminal/unavailable, or somebody else claimed
    // this run. Let the real worker's outcome stand, but do not claim a crash.
    process.exitCode = 1
  } finally {
    raw.close()
  }
}

async function interruptInvocation(invocation: RunInvocation, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), '--interrupt-worker'],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === INTERRUPTED_EXIT_CODE && signal === null) resolve()
      else reject(new Error('worker did not stop after a committed pending observation'))
    })
    child.stdin.on('error', () => {
      // Child exit/error decides the receipt; a closed stdin is not a second
      // unhandled error and never prints the invocation's private claim token.
    })
    child.stdin.end(JSON.stringify(invocation))
  })
}

async function receipt(): Promise<void> {
  const baseUrl = requireHostedReceiptBaseUrl(requiredEnv('DURABLERUN_BASE_URL'))
  const apiToken = requiredEnv('DURABLERUN_API_TOKEN')
  const queue = requiredEnv('DURABLERUN_QUEUE')
  const input = parsePrWatchInput(JSON.parse(requiredEnv('PR_WATCHER_INPUT')))
  if (input.maxPolls < 2) throw new Error('interruption receipt requires at least two polls')
  const startedAt = new Date().toISOString()
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS
  function remainingMs(): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`watcher receipt exceeded ${RECEIPT_TIMEOUT_MS}ms`)
    return remaining
  }

  async function inspect(taskId: string): Promise<Record<string, unknown>> {
    const response = await fetch(
      new URL(`/api/inspect?taskId=${encodeURIComponent(taskId)}`, baseUrl),
      {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(Math.min(10_000, remainingMs())),
      },
    )
    if (!response.ok) throw new Error(`hosted inspect returned HTTP ${response.status}`)
    return object(await response.json())
  }

  if (!pendingObservation(await observeGitHubChecks(input), input)) {
    throw new Error('receipt requires an open exact-head PR with selected checks still pending')
  }
  const raw = openDatabase()
  const ids = systemIdSource()
  const store = new LibsqlSchedulerStore(raw, ids)
  try {
    const [live] = await raw.batch(
      'pr-watcher-receipt:idle',
      [
        {
          sql: "SELECT COUNT(*) AS count FROM tasks WHERE queue = ? AND state IN ('pending', 'running', 'sleeping')",
          args: [queue],
        },
      ],
      'read',
    )
    if (integer(live?.rows[0]?.count) !== 0) {
      throw new Error('receipt requires an otherwise idle dedicated alpha queue')
    }

    const spawned = await store.spawn(
      queue,
      PR_WATCHER_TASK,
      serializeTaskValue('watch input', input),
      {
        idempotencyKey: `pr-watcher-interruption-${randomUUID()}`,
      },
    )
    if (!spawned.created) throw new Error('receipt task unexpectedly existed')
    const claimed = await store.claim(queue, ids.token(), { leaseSeconds: 30, limit: 1 })
    const run = claimed[0]
    if (claimed.length !== 1 || run?.taskId !== spawned.taskId) {
      throw new Error(
        'receipt did not claim its own task; hosted recovery may already have started',
      )
    }
    await interruptInvocation(
      { queue, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
      Math.min(CHILD_TIMEOUT_MS, remainingMs()),
    )

    const checkpoints = await store.getCheckpoints(queue, spawned.taskId, run.attempt)
    const first = checkpoints.find(
      (checkpoint) => checkpoint.checkpointName === PR_WATCHER_OBSERVATION_STEP,
    )
    if (
      checkpoints.length !== 1 ||
      first === undefined ||
      first.ownerRunId !== run.runId ||
      first.ownerAttempt !== 1 ||
      !pendingObservation(parseTaskValueJson(first.stateJson), input)
    ) {
      throw new Error('interrupted worker did not leave exactly its pending observation checkpoint')
    }
    const [interrupted] = await raw.batch(
      'pr-watcher-receipt:interrupted',
      [
        {
          sql: 'SELECT state, claim_gen, activated_gen, claim_expires_at_ms FROM runs WHERE queue = ? AND run_id = ? AND task_id = ?',
          args: [queue, run.runId, spawned.taskId],
        },
      ],
      'read',
    )
    const interruptedRun = interrupted?.rows[0]
    if (
      interruptedRun?.state !== 'running' ||
      integer(interruptedRun.claim_gen) !== run.claimGen ||
      integer(interruptedRun.activated_gen) !== run.claimGen
    ) {
      throw new Error('receipt did not observe the activated run left running after process death')
    }

    // From here forward this process only inspects. No tick, lease expiry,
    // sweep, wake hint, local worker, or fixture SQL helps the deployment.
    let completed: Record<string, unknown>
    for (;;) {
      const task = await inspect(spawned.taskId)
      if (task.state === 'completed') {
        completed = task
        break
      }
      if (task.state === 'failed' || task.state === 'cancelled') {
        throw new Error(`watcher task reached ${String(task.state)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, remainingMs())))
    }
    const result = object(completed.result)
    if (
      !['ready', 'failed'].includes(String(result.status)) ||
      result.repository !== input.repository ||
      result.pullNumber !== input.pullNumber ||
      result.headSha !== input.headSha ||
      result.attempt !== 1 ||
      integer(result.polls) < 2
    ) {
      throw new Error(
        'watcher did not produce an exact-head ready/failed result on user attempt one',
      )
    }

    const [history] = await raw.batch(
      'pr-watcher-receipt:recovery',
      [
        {
          sql: `SELECT r.run_id, r.state, r.attempt, r.completed_at_ms, t.infra_retries, t.attempts
                FROM runs r JOIN tasks t ON t.task_id = r.task_id AND t.queue = r.queue
                WHERE r.queue = ? AND r.task_id = ? ORDER BY r.attempt`,
          args: [queue, spawned.taskId],
        },
      ],
      'read',
    )
    const rows = history?.rows ?? []
    const original = rows[0]
    const successor = rows[1]
    if (
      rows.length !== 2 ||
      original?.run_id !== run.runId ||
      original.state !== 'failed' ||
      integer(original.attempt) !== 1 ||
      successor?.state !== 'completed' ||
      integer(successor.attempt) !== 2 ||
      integer(successor.infra_retries) !== 1 ||
      integer(successor.attempts) !== 0
    ) {
      throw new Error(
        'recovery did not create exactly one infrastructure successor without user failures',
      )
    }
    const recovered = await store.getCheckpoints(queue, spawned.taskId, 2)
    const originalAfter = recovered.find(
      (checkpoint) => checkpoint.checkpointName === PR_WATCHER_OBSERVATION_STEP,
    )
    if (
      first.stateJson !== originalAfter?.stateJson ||
      first.ownerRunId !== originalAfter.ownerRunId ||
      first.ownerAttempt !== originalAfter.ownerAttempt
    ) {
      throw new Error('recovery replaced the original committed GitHub observation')
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          startedAt,
          finishedAt: new Date().toISOString(),
          taskId: spawned.taskId,
          input,
          manualTicks: 0,
          interrupted: {
            exitCode: INTERRUPTED_EXIT_CODE,
            runId: run.runId,
            activatedRunObserved: true,
            leaseExpiresAtEpochMs: integer(interruptedRun.claim_expires_at_ms),
            checkpoint: parseTaskValueJson(first.stateJson),
          },
          recovered: {
            runId: successor.run_id,
            runAttempt: 2,
            infraRetries: 1,
            userAttempt: 1,
            userFailures: 0,
            originalCheckpointUnchanged: true,
            completedAtEpochMs: integer(successor.completed_at_ms),
            result,
          },
          limits: { receiptTimeoutMs: RECEIPT_TIMEOUT_MS },
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    raw.close()
  }
}

if (process.argv[2] === '--interrupt-worker') await interruptedWorker()
else await receipt()

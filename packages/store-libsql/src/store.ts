import type {
  Checkpoint,
  ClaimedRun,
  IdSource,
  LeaseState,
  RetryStrategy,
  SchedulerStore,
  SpawnOptions,
  SpawnResult,
  SqlExecutor,
  SqlRow,
  SweptRun,
  TaskResult,
} from '@absurd-lite/core'
import { NOW_MS } from './time.js'

const DEFAULT_RETRY: RetryStrategy = {
  kind: 'exponential',
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 3600,
}
const DEFAULT_MAX_ATTEMPTS = 5

/**
 * SchedulerStore on SQLite/libsql (DESIGN.md §3.4). Every method is ONE
 * atomic labeled batch; fences follow rule 1 (first statement is the guarded
 * CAS, follow-ons key on the post-state + claim token); all timestamps come
 * from NOW_MS (rule 3). Methods marked "PR1.5/1.6" land in the next diffs.
 */
export class LibsqlSchedulerStore implements SchedulerStore {
  constructor(
    private readonly db: SqlExecutor,
    private readonly ids: IdSource,
  ) {}

  async spawn(
    queue: string,
    taskName: string,
    paramsJson: string,
    opts: SpawnOptions = {},
  ): Promise<SpawnResult> {
    const taskId = this.ids.uuidv7()
    const runId = this.ids.uuidv7()
    const retry = JSON.stringify(opts.retryStrategy ?? DEFAULT_RETRY)
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const enqueueAt =
      opts.enqueueAtEpochMs !== undefined ? String(opts.enqueueAtEpochMs) : `(${NOW_MS})`

    const [, , chosen] = await this.db.batch('spawn', [
      // 1. Idempotent task insert: loses silently when the key already exists.
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, headers, retry_strategy,
                max_attempts, cancellation, idempotency_key, state, enqueue_at_ms, created_at_ms)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ${enqueueAt}, ${NOW_MS}
              WHERE 1
              ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL
              DO NOTHING`,
        args: [
          taskId,
          queue,
          taskName,
          paramsJson,
          opts.headers ? JSON.stringify(opts.headers) : null,
          retry,
          maxAttempts,
          opts.cancellation ? JSON.stringify(opts.cancellation) : null,
          opts.idempotencyKey ?? null,
        ],
      },
      // 2. Initial run — only when OUR task insert won (post-state key, rule 1).
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
              SELECT ?, ?, task_id, 1, 'pending', enqueue_at_ms, ${NOW_MS}
              FROM tasks WHERE task_id = ?`,
        args: [runId, queue, taskId],
      },
      // 3. Resolve winner (ours or the pre-existing task for this key).
      {
        sql: `SELECT t.task_id AS task_id,
                     (SELECT r.run_id FROM runs r WHERE r.task_id = t.task_id
                        ORDER BY r.run_id DESC LIMIT 1) AS run_id
              FROM tasks t
              WHERE t.task_id = ?
                 OR (? IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?)
              ORDER BY (t.task_id = ?) DESC
              LIMIT 1`,
        args: [taskId, opts.idempotencyKey ?? null, queue, opts.idempotencyKey ?? null, taskId],
      },
    ])

    const row = chosen?.rows[0]
    if (!row) throw new Error('spawn: winner resolution returned no row')
    const wonTaskId = String(row.task_id)
    const wonRunId = row.run_id === null ? runId : String(row.run_id)
    return { taskId: wonTaskId, runId: wonRunId, created: wonTaskId === taskId }
  }

  async claim(
    queue: string,
    claimToken: string,
    leaseSeconds: number,
    limit: number,
  ): Promise<ClaimedRun[]> {
    const [, , , picked] = await this.db.batch('claim', [
      // 1. The claim CAS: due runs of live tasks → running, stamped with the
      //    fresh token and an incremented per-claim generation.
      {
        sql: `UPDATE runs SET
                state = 'running',
                claimed_by = ?,
                claim_gen = claim_gen + 1,
                lease_seconds = ?,
                claim_expires_at_ms = ${NOW_MS} + ? * 1000
              WHERE run_id IN (
                SELECT r.run_id FROM runs r
                JOIN tasks t ON t.task_id = r.task_id
                WHERE r.queue = ?
                  AND r.state IN ('pending','sleeping')
                  AND t.state IN ('pending','sleeping','running')
                  AND r.available_at_ms IS NOT NULL
                  AND r.available_at_ms <= ${NOW_MS}
                ORDER BY r.available_at_ms, r.run_id
                LIMIT ?
              )`,
        args: [claimToken, leaseSeconds, leaseSeconds, queue, limit],
      },
      // 2. Task bookkeeping, keyed on the post-state + token.
      {
        sql: `UPDATE tasks SET
                state = 'running',
                attempts = MAX(attempts, (
                  SELECT r.attempt FROM runs r
                  WHERE r.task_id = tasks.task_id AND r.claimed_by = ? AND r.state = 'running'
                )),
                last_attempt_run = (
                  SELECT r.run_id FROM runs r
                  WHERE r.task_id = tasks.task_id AND r.claimed_by = ? AND r.state = 'running'
                )
              WHERE task_id IN (
                SELECT task_id FROM runs
                WHERE queue = ? AND claimed_by = ? AND state = 'running'
              )`,
        args: [claimToken, claimToken, queue, claimToken],
      },
      // 3. A timed-out waiter's claim consumes its wait row, so a later emit
      //    cannot resurrect a timed-out wait (§3.4 rule 2, timeout branch).
      {
        sql: `DELETE FROM waits
              WHERE run_id IN (
                SELECT run_id FROM runs WHERE queue = ? AND claimed_by = ? AND state = 'running'
              )
                AND status = 'waiting'
                AND timeout_at_ms IS NOT NULL
                AND timeout_at_ms <= ${NOW_MS}`,
        args: [queue, claimToken],
      },
      // 4. Hand back run⋈task data for the launch payloads.
      {
        sql: `SELECT r.run_id, r.task_id, r.attempt, r.claim_gen, r.wake_event, r.event_payload,
                     t.task_name, t.params, t.retry_strategy, t.max_attempts, t.headers
              FROM runs r JOIN tasks t ON t.task_id = r.task_id
              WHERE r.queue = ? AND r.claimed_by = ? AND r.state = 'running'
              ORDER BY r.run_id`,
        args: [queue, claimToken],
      },
    ])
    return (picked?.rows ?? []).map((row) => decodeClaimedRun(row, claimToken))
  }

  async activate(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
  ): Promise<boolean> {
    const [cas] = await this.db.batch('activate', [
      // Per-claim latch: only this claim's first delivery passes; re-extends
      // the lease so channel-delayed launches don't start life nearly expired.
      {
        sql: `UPDATE runs SET
                activated_gen = ?,
                started_at_ms = COALESCE(started_at_ms, ${NOW_MS}),
                claim_expires_at_ms = ${NOW_MS} + lease_seconds * 1000
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
                AND claim_gen = ? AND activated_gen < ?`,
        args: [claimGen, runId, queue, claimToken, claimGen, claimGen],
      },
      // First-ever start stamps the task, keyed on the post-state.
      {
        sql: `UPDATE tasks SET first_started_at_ms = COALESCE(first_started_at_ms, ${NOW_MS})
              WHERE task_id = (
                SELECT task_id FROM runs
                WHERE run_id = ? AND claimed_by = ? AND activated_gen = ?
              )`,
        args: [runId, claimToken, claimGen],
      },
    ])
    return (cas?.rowsAffected ?? 0) === 1
  }

  async heartbeat(
    queue: string,
    runId: string,
    claimToken: string,
    extendSeconds: number,
  ): Promise<LeaseState> {
    const [extended, remaining] = await this.db.batch('heartbeat', [
      {
        sql: `UPDATE runs SET claim_expires_at_ms = ${NOW_MS} + ? * 1000
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'`,
        args: [extendSeconds, runId, queue, claimToken],
      },
      {
        sql: `SELECT claim_expires_at_ms - ${NOW_MS} AS remaining_ms
              FROM runs
              WHERE run_id = ? AND claimed_by = ? AND state = 'running'`,
        args: [runId, claimToken],
      },
    ])
    if ((extended?.rowsAffected ?? 0) !== 1) return { held: false, remainingMs: 0 }
    return { held: true, remainingMs: Number(remaining?.rows[0]?.remaining_ms ?? 0) }
  }

  // ── PR1.5 ──────────────────────────────────────────────────────────────
  reschedule(): Promise<void> {
    return notYet('reschedule')
  }
  complete(): Promise<void> {
    return notYet('complete')
  }
  fail(): Promise<void> {
    return notYet('fail')
  }
  sweep(): Promise<SweptRun[]> {
    return notYet('sweep')
  }
  expireLeaseNow(): Promise<boolean> {
    return notYet('expireLeaseNow')
  }
  cancelTask(): Promise<boolean> {
    return notYet('cancelTask')
  }

  // ── PR1.6 ──────────────────────────────────────────────────────────────
  getCheckpoints(): Promise<Checkpoint[]> {
    return notYet('getCheckpoints')
  }
  setCheckpoint(): Promise<void> {
    return notYet('setCheckpoint')
  }
  emitEvent(): Promise<void> {
    return notYet('emitEvent')
  }
  awaitEvent(): Promise<{ emitted: true; payloadJson: string } | { emitted: false }> {
    return notYet('awaitEvent')
  }
  getTaskResult(): Promise<TaskResult | null> {
    return notYet('getTaskResult')
  }
  nextWakeAtEpochMs(): Promise<number | null> {
    return notYet('nextWakeAtEpochMs')
  }
}

function notYet(method: string): Promise<never> {
  return Promise.reject(
    new Error(`LibsqlSchedulerStore.${method}: not implemented until PR1.5/1.6`),
  )
}

function decodeClaimedRun(row: SqlRow, claimToken: string): ClaimedRun {
  const claimed: ClaimedRun = {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    taskName: String(row.task_name),
    attempt: Number(row.attempt),
    claimGen: Number(row.claim_gen),
    claimToken,
    paramsJson: String(row.params),
    retryStrategy: JSON.parse(String(row.retry_strategy)) as RetryStrategy,
    maxAttempts: Number(row.max_attempts),
    headers:
      row.headers === null ? {} : (JSON.parse(String(row.headers)) as Record<string, string>),
  }
  if (row.wake_event !== null) {
    claimed.wakeEvent = String(row.wake_event)
    claimed.eventPayloadJson = row.event_payload === null ? null : String(row.event_payload)
  }
  return claimed
}

import {
  type Buggify,
  type Checkpoint,
  type ClaimedRun,
  type IdSource,
  type LeaseState,
  neverBuggify,
  normalizeRetryStrategy,
  type RetryStrategy,
  type SchedulerStore,
  type SpawnOptions,
  type SpawnResult,
  type SqlExecutor,
  type SqlRow,
  type SweptRun,
  type TaskResult,
} from '@durablerun/core'
import { NOW_MS } from './time.js'

const DEFAULT_RETRY: RetryStrategy = {
  kind: 'exponential',
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 3600,
}
const DEFAULT_MAX_ATTEMPTS = 5

export interface StoreOptions {
  buggify?: Buggify
  /** Lost-launch reopens before the run (and task) fail terminally. */
  relaunchCap?: number
  /** `$ClaimTimeout` successors per task before terminal failure (generous). */
  infraRetryCap?: number
}
const DEFAULT_RELAUNCH_CAP = 5
const DEFAULT_INFRA_RETRY_CAP = 20
/** Seconds before a claim-timeout successor becomes claimable. */
const INFRA_BACKOFF_SECONDS = 5

/** Columns needed to decode a ClaimedRun (shared by claim and activate). */
const CLAIMED_RUN_COLUMNS = `r.run_id, r.task_id, r.attempt, r.claim_gen, r.claim_expires_at_ms,
       r.wake_event, r.event_payload,
       t.task_name, t.params, t.retry_strategy, t.max_attempts, t.headers, t.infra_retries`

/**
 * SchedulerStore on SQLite/libsql (DESIGN.md §3.4). Every method is ONE
 * atomic labeled batch; fences follow rule 1 (first statement is the guarded
 * CAS, follow-ons key on the post-state + claim token); all timestamps come
 * from NOW_MS (rule 3). Methods marked "PR1.5/1.6" land in the next diffs.
 */
export class LibsqlSchedulerStore implements SchedulerStore {
  private readonly buggify: Buggify
  private readonly relaunchCap: number
  private readonly infraRetryCap: number

  constructor(
    private readonly db: SqlExecutor,
    private readonly ids: IdSource,
    opts: StoreOptions = {},
  ) {
    this.buggify = opts.buggify ?? neverBuggify
    this.relaunchCap = opts.relaunchCap ?? DEFAULT_RELAUNCH_CAP
    this.infraRetryCap = opts.infraRetryCap ?? DEFAULT_INFRA_RETRY_CAP
  }

  async spawn(
    queue: string,
    taskName: string,
    paramsJson: string,
    opts: SpawnOptions = {},
  ): Promise<SpawnResult> {
    const taskId = this.ids.uuidv7()
    const runId = this.ids.uuidv7()
    const retry = JSON.stringify(normalizeRetryStrategy(opts.retryStrategy ?? DEFAULT_RETRY))
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const delayMs = Math.round((opts.startDelaySeconds ?? 0) * 1000)
    const maxDelay = opts.cancellation?.maxDelaySeconds

    const [, , chosen] = await this.db.batch('spawn', [
      // 1. Idempotent task insert: loses silently when the key already
      //    exists. enqueue/cancel deadlines are computed in SQL (rule 3);
      //    cancel_at_ms materializes max_delay so sweeps and nextWakeAt are
      //    indexed reads, never JSON scans.
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, headers, retry_strategy,
                max_attempts, cancellation, idempotency_key, state, enqueue_at_ms,
                cancel_at_ms, created_at_ms)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ${NOW_MS} + ?,
                CASE WHEN ? IS NOT NULL THEN ${NOW_MS} + ? + ? * 1000 ELSE NULL END,
                ${NOW_MS}
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
          delayMs,
          maxDelay ?? null,
          delayMs,
          maxDelay ?? null,
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
    opts: { leaseSeconds: number; limit: number },
  ): Promise<ClaimedRun[]> {
    const { leaseSeconds, limit } = opts
    // Buggify: a short claim is always legal (limit is a maximum) — ticks
    // must drain via the successor-tick chain, never assume a full batch.
    const effectiveLimit = limit > 1 && this.buggify('claim:short-batch') ? 1 : limit
    const [, , , picked] = await this.db.batch('claim', [
      // 1. The claim CAS: due runs of live tasks → running, stamped with the
      //    fresh token and an incremented per-claim generation. The candidate
      //    subselect is a bounded per-state UNION so each leg is an ordered
      //    covering-index scan of ≤K rows — no temp b-tree over the backlog
      //    (prevention: the query-plan test suite pins this shape).
      {
        sql: `UPDATE runs SET
                state = 'running',
                claimed_by = ?,
                claim_gen = claim_gen + 1,
                lease_seconds = ?,
                claim_expires_at_ms = ${NOW_MS} + ? * 1000,
                heartbeat_at_ms = ${NOW_MS}
              WHERE run_id IN (
                SELECT c.run_id FROM (
                  SELECT * FROM (
                    SELECT r.run_id, r.available_at_ms FROM runs r
                    WHERE r.queue = ? AND r.state = 'pending'
                      AND r.available_at_ms IS NOT NULL AND r.available_at_ms <= ${NOW_MS}
                    ORDER BY r.available_at_ms, r.run_id LIMIT ?
                  )
                  UNION ALL
                  SELECT * FROM (
                    SELECT r.run_id, r.available_at_ms FROM runs r
                    WHERE r.queue = ? AND r.state = 'sleeping'
                      AND r.available_at_ms IS NOT NULL AND r.available_at_ms <= ${NOW_MS}
                    ORDER BY r.available_at_ms, r.run_id LIMIT ?
                  )
                ) c
                JOIN runs cr ON cr.run_id = c.run_id
                JOIN tasks t ON t.task_id = cr.task_id
                WHERE t.state IN ('pending','sleeping','running')
                ORDER BY c.available_at_ms, c.run_id
                LIMIT ?
              )`,
        args: [
          claimToken,
          leaseSeconds,
          leaseSeconds,
          queue,
          effectiveLimit,
          queue,
          effectiveLimit,
          effectiveLimit,
        ],
      },
      // 2. Task bookkeeping, keyed on the post-state + token. attempts is the
      //    USER-attempt watermark: run.attempt is the fence ordinal (counts
      //    infra successors too), so the user ordinal subtracts infra_retries
      //    — the TLA+ AttemptAccounting invariant; a plain MAX(attempt) here
      //    would burn max_attempts budget on infrastructure failures.
      {
        sql: `UPDATE tasks SET
                state = 'running',
                attempts = MAX(attempts, (
                  SELECT r.attempt FROM runs r
                  WHERE r.task_id = tasks.task_id AND r.claimed_by = ? AND r.state = 'running'
                ) - infra_retries),
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
        sql: `SELECT ${CLAIMED_RUN_COLUMNS}
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
  ): Promise<ClaimedRun | null> {
    // Buggify: a lost activation is always legal — the launch channel may
    // drop any delivery; the sweep classifies and relaunches without cost.
    if (this.buggify('activate:lost')) return null
    const [cas, , data] = await this.db.batch('activate', [
      // Per-claim latch: only this claim's first delivery passes; re-extends
      // the lease so channel-delayed launches don't start life nearly expired.
      {
        sql: `UPDATE runs SET
                activated_gen = ?,
                started_at_ms = COALESCE(started_at_ms, ${NOW_MS}),
                claim_expires_at_ms = ${NOW_MS} + lease_seconds * 1000,
                heartbeat_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
                AND claim_gen = ? AND activated_gen < ?`,
        args: [claimGen, runId, queue, claimToken, claimGen, claimGen],
      },
      // First-ever start stamps the task and tightens cancel_at_ms with the
      // max_duration deadline — keyed on the post-state.
      {
        sql: `UPDATE tasks SET
                first_started_at_ms = COALESCE(first_started_at_ms, ${NOW_MS}),
                cancel_at_ms = CASE
                  WHEN json_extract(cancellation, '$.maxDurationSeconds') IS NOT NULL THEN
                    MIN(
                      COALESCE(cancel_at_ms, 9e15),
                      COALESCE(first_started_at_ms, ${NOW_MS})
                        + json_extract(cancellation, '$.maxDurationSeconds') * 1000
                    )
                  ELSE cancel_at_ms
                END
              WHERE task_id = (
                SELECT task_id FROM runs
                WHERE run_id = ? AND claimed_by = ? AND activated_gen = ?
              )`,
        args: [runId, claimToken, claimGen],
      },
      // Full payload for the winning worker, keyed on the post-CAS state.
      {
        sql: `SELECT ${CLAIMED_RUN_COLUMNS}
              FROM runs r JOIN tasks t ON t.task_id = r.task_id
              WHERE r.run_id = ? AND r.claimed_by = ? AND r.state = 'running'
                AND r.claim_gen = ? AND r.activated_gen = ?`,
        args: [runId, claimToken, claimGen, claimGen],
      },
    ])
    // The SELECT's post-state cannot distinguish "this delivery won" from "a
    // prior delivery of the SAME claim already won" — both show
    // activated_gen = claim_gen. The CAS's own rowsAffected is the
    // discriminator: a duplicate delivery matches zero rows because
    // activated_gen is no longer < claim_gen. This is why the executor's
    // rowsAffected contract (primitives.ts) is load-bearing.
    if ((cas?.rowsAffected ?? 0) !== 1) return null
    const row = data?.rows[0]
    return row ? decodeClaimedRun(row, claimToken) : null
  }

  async heartbeat(
    queue: string,
    runId: string,
    claimToken: string,
    extendSeconds: number,
  ): Promise<LeaseState> {
    // Buggify: lease-lost can arrive at ANY heartbeat — workers must abort
    // cleanly on the AB002 signal no matter when it fires.
    if (this.buggify('heartbeat:lease-lost')) return { held: false, remainingMs: 0 }
    const [extended, remaining] = await this.db.batch('heartbeat', [
      {
        sql: `UPDATE runs SET
                claim_expires_at_ms = ${NOW_MS} + ? * 1000,
                heartbeat_at_ms = ${NOW_MS}
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

  /**
   * §3.1 steps 0–1. Discovery is a read-only scan; every transition is a
   * per-item atomic batch whose FIRST statement is the ownership CAS —
   * concurrent sweepers race on it and the loser's whole batch matches
   * nothing (the unique (task_id, attempt) index is the structural backstop
   * against duplicate successors). Classification is decided by activation
   * state: `activated_gen < claim_gen` = the launch was lost.
   */
  async sweep(queue: string, limit: number): Promise<SweptRun[]> {
    const effectiveLimit = limit > 1 && this.buggify('sweep:short-batch') ? 1 : limit
    const [cancels, expired] = await this.db.batch(
      'sweep:scan',
      [
        {
          sql: `SELECT t.task_id,
                       (SELECT r.run_id FROM runs r
                          WHERE r.task_id = t.task_id
                            AND r.state IN ('pending','running','sleeping')
                          ORDER BY r.run_id DESC LIMIT 1) AS run_id
                FROM tasks t
                WHERE t.queue = ? AND t.cancel_at_ms IS NOT NULL AND t.cancel_at_ms <= ${NOW_MS}
                  AND t.state IN ('pending','running','sleeping')
                LIMIT ?`,
          args: [queue, effectiveLimit],
        },
        {
          sql: `SELECT r.run_id, r.claim_gen, r.activated_gen
                FROM runs r
                WHERE r.queue = ? AND r.state = 'running'
                  AND r.claim_expires_at_ms IS NOT NULL AND r.claim_expires_at_ms <= ${NOW_MS}
                ORDER BY r.claim_expires_at_ms, r.run_id
                LIMIT ?`,
          args: [queue, effectiveLimit],
        },
      ],
      'read',
    )

    const swept: SweptRun[] = []
    for (const row of cancels?.rows ?? []) {
      const outcome = await this.cancelBatch(queue, String(row.task_id), true)
      if (outcome) {
        swept.push({
          kind: 'cancelled',
          taskId: String(row.task_id),
          runId: row.run_id === null ? '' : String(row.run_id),
        })
      }
    }
    for (const row of expired?.rows ?? []) {
      const runId = String(row.run_id)
      const claimGen = Number(row.claim_gen)
      const outcome =
        Number(row.activated_gen) < claimGen
          ? await this.sweepLostLaunch(queue, runId, claimGen)
          : await this.sweepClaimTimeout(queue, runId, claimGen)
      if (outcome) swept.push(outcome)
    }
    return swept
  }

  private async sweepLostLaunch(
    queue: string,
    runId: string,
    claimGen: number,
  ): Promise<SweptRun | null> {
    const fence = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?
                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW_MS}`
    const [reopened, capped, , state] = await this.db.batch('sweep:lost-launch', [
      // The launch never activated: reopen the SAME run — no new row, no
      // attempt consumed — with linear backoff on the relaunch counter.
      {
        sql: `UPDATE runs SET
                state = 'pending', claimed_by = NULL, claim_expires_at_ms = NULL,
                heartbeat_at_ms = NULL, relaunch_count = relaunch_count + 1,
                available_at_ms = ${NOW_MS} + MIN((relaunch_count + 1) * 5, 60) * 1000
              WHERE ${fence} AND relaunch_count < ?`,
        args: [runId, queue, claimGen, this.relaunchCap],
      },
      // Past the cap: a broken launcher must surface as failed work, never
      // an infinite launch loop (TLA-pinned: the task fails with the run).
      {
        sql: `UPDATE runs SET
                state = 'failed', failed_at_ms = ${NOW_MS}, claimed_by = NULL,
                claim_expires_at_ms = NULL,
                failure_reason = '{"name":"$RelaunchCapExhausted"}'
              WHERE ${fence} AND relaunch_count >= ?`,
        args: [runId, queue, claimGen, this.relaunchCap],
      },
      {
        sql: `UPDATE tasks SET state = 'failed',
                failure_reason = '{"name":"$RelaunchCapExhausted"}'
              WHERE task_id = (
                SELECT task_id FROM runs
                WHERE run_id = ? AND state = 'failed'
                  AND failure_reason = '{"name":"$RelaunchCapExhausted"}'
              )`,
        args: [runId],
      },
      {
        sql: `SELECT task_id, relaunch_count FROM runs WHERE run_id = ?`,
        args: [runId],
      },
    ])
    const info = state?.rows[0]
    if (!info) return null
    if ((reopened?.rowsAffected ?? 0) === 1) {
      return {
        kind: 'lost-launch',
        runId,
        taskId: String(info.task_id),
        relaunchCount: Number(info.relaunch_count),
      }
    }
    if ((capped?.rowsAffected ?? 0) === 1) {
      return { kind: 'relaunch-cap-exhausted', runId, taskId: String(info.task_id) }
    }
    return null // lost the race to another sweeper
  }

  private async sweepClaimTimeout(
    queue: string,
    runId: string,
    claimGen: number,
  ): Promise<SweptRun | null> {
    const successorId = this.ids.uuidv7()
    const [failed, , , booked, taskSel] = await this.db.batch('sweep:claim-timeout', [
      // Ownership CAS: the activated worker died (or was partitioned).
      {
        sql: `UPDATE runs SET
                state = 'failed', failed_at_ms = ${NOW_MS},
                failure_reason = '{"name":"$ClaimTimeout"}'
              WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?
                AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW_MS}`,
        args: [runId, queue, claimGen],
      },
      // Successor under the infra cap, carrying the run-DB pointer and any
      // parked event wake (§3.8.2). OR IGNORE + the unique (task_id, attempt)
      // index make a racing sweeper's duplicate insert a silent no-op.
      {
        sql: `INSERT OR IGNORE INTO runs
                (run_id, queue, task_id, attempt, state, available_at_ms,
                 wake_event, event_payload, run_db, created_at_ms)
              SELECT ?, r.queue, r.task_id, r.attempt + 1, 'pending',
                     ${NOW_MS} + ${INFRA_BACKOFF_SECONDS} * 1000,
                     r.wake_event, r.event_payload, r.run_db, ${NOW_MS}
              FROM runs r JOIN tasks t ON t.task_id = r.task_id
              WHERE r.run_id = ? AND r.state = 'failed'
                AND r.failure_reason = '{"name":"$ClaimTimeout"}'
                AND t.state <> 'failed' AND t.infra_retries < ?`,
        args: [successorId, runId, this.infraRetryCap],
      },
      // At the cap (checked pre-increment) with no live successor: terminal.
      {
        sql: `UPDATE tasks SET state = 'failed',
                failure_reason = '{"name":"$InfraRetriesExhausted"}'
              WHERE task_id = (
                SELECT task_id FROM runs WHERE run_id = ? AND state = 'failed'
                  AND failure_reason = '{"name":"$ClaimTimeout"}'
              )
                AND state IN ('pending','running','sleeping')
                AND infra_retries >= ?
                AND NOT EXISTS (
                  SELECT 1 FROM runs rr
                  WHERE rr.task_id = tasks.task_id AND rr.state = 'pending'
                    AND rr.attempt = (SELECT attempt FROM runs WHERE run_id = ?) + 1
                )`,
        args: [runId, this.infraRetryCap, runId],
      },
      // Bookkeeping keyed on OUR successor existing (a racing sweeper whose
      // insert was ignored must not double-increment infra_retries).
      {
        sql: `UPDATE tasks SET
                infra_retries = infra_retries + 1, state = 'pending',
                last_attempt_run = ?
              WHERE task_id = (SELECT task_id FROM runs WHERE run_id = ?)
                AND state <> 'failed'
                AND EXISTS (SELECT 1 FROM runs WHERE run_id = ?)`,
        args: [successorId, runId, successorId],
      },
      {
        sql: `SELECT task_id FROM runs WHERE run_id = ?`,
        args: [runId],
      },
    ])
    if ((failed?.rowsAffected ?? 0) !== 1) return null // lost the race
    const taskId = String(taskSel?.rows[0]?.task_id)
    if ((booked?.rowsAffected ?? 0) === 1) {
      return { kind: 'claim-timeout', runId, taskId, successorRunId: successorId }
    }
    return { kind: 'infra-cap-exhausted', runId, taskId }
  }

  /** The single advisory write (§3.9): accelerate lease expiry, nothing more. */
  async expireLeaseNow(queue: string, runId: string, claimToken: string): Promise<boolean> {
    const [expired] = await this.db.batch('expire-lease-now', [
      {
        sql: `UPDATE runs SET claim_expires_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'`,
        args: [runId, queue, claimToken],
      },
    ])
    return (expired?.rowsAffected ?? 0) === 1
  }

  async cancelTask(queue: string, taskId: string): Promise<boolean> {
    return this.cancelBatch(queue, taskId, false)
  }

  /** Shared by explicit cancelTask and the sweep's deadline enforcement. */
  private async cancelBatch(
    queue: string,
    taskId: string,
    deadlineOnly: boolean,
  ): Promise<boolean> {
    const deadlineGuard = deadlineOnly
      ? `AND cancel_at_ms IS NOT NULL AND cancel_at_ms <= ${NOW_MS}`
      : ''
    const [cancelled] = await this.db.batch('cancel-task', [
      {
        sql: `UPDATE tasks SET state = 'cancelled', cancelled_at_ms = ${NOW_MS},
                cancel_at_ms = NULL
              WHERE task_id = ? AND queue = ?
                AND state IN ('pending','running','sleeping') ${deadlineGuard}`,
        args: [taskId, queue],
      },
      {
        sql: `UPDATE runs SET state = 'cancelled', claimed_by = NULL,
                claim_expires_at_ms = NULL
              WHERE task_id = ? AND state IN ('pending','running','sleeping')
                AND (SELECT state FROM tasks WHERE task_id = ?) = 'cancelled'`,
        args: [taskId, taskId],
      },
      {
        sql: `DELETE FROM waits WHERE task_id = ?
                AND (SELECT state FROM tasks WHERE task_id = ?) = 'cancelled'`,
        args: [taskId, taskId],
      },
    ])
    return (cancelled?.rowsAffected ?? 0) === 1
  }

  // ── PR1.6 ──────────────────────────────────────────────────────────────
  reschedule(): Promise<void> {
    return notYet('reschedule')
  }
  complete(): Promise<void> {
    return notYet('complete')
  }
  fail(): Promise<void> {
    return notYet('fail')
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
    infraRetries: Number(row.infra_retries),
    claimGen: Number(row.claim_gen),
    claimToken,
    claimExpiresAtEpochMs: Number(row.claim_expires_at_ms),
    paramsJson: String(row.params),
    retryStrategy: JSON.parse(String(row.retry_strategy)) as RetryStrategy,
    maxAttempts: Number(row.max_attempts),
    headers:
      row.headers === null ? {} : (JSON.parse(String(row.headers)) as Record<string, string>),
  }
  if (row.wake_event !== null) {
    claimed.wake =
      row.event_payload === null
        ? { event: String(row.wake_event), timedOut: true }
        : { event: String(row.wake_event), payloadJson: String(row.event_payload) }
  }
  return claimed
}

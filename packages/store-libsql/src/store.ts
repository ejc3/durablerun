import {
  type Buggify,
  type Checkpoint,
  type ClaimedRun,
  FencedBatch,
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
  STAMP,
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

/**
 * Contract constants (DESIGN.md §3.1/§3.8.2 pins them; the conformance suite
 * asserts them; dialects must match them — they are spec, not tuning knobs).
 */
export const RELAUNCH_CAP = 5
export const INFRA_RETRY_CAP = 20
export const INFRA_BACKOFF_SECONDS = 5
export const RELAUNCH_BACKOFF_BASE_SECONDS = 5
export const RELAUNCH_BACKOFF_MAX_SECONDS = 60

/**
 * Terminal failure reasons. Since the FencedBatch stamps carry batch
 * ownership, these are pure data (never fence keys) — but they are still
 * wire-visible contract values shared with the conformance suite.
 */
export const REASON_CLAIM_TIMEOUT = '{"name":"$ClaimTimeout"}'
export const REASON_RELAUNCH_CAP = '{"name":"$RelaunchCapExhausted"}'
export const REASON_INFRA_CAP = '{"name":"$InfraRetriesExhausted"}'

/** Non-terminal states — one definition, everywhere (drift was reviewed). */
const LIVE = `('pending','running','sleeping')`

/** Columns needed to decode a ClaimedRun (shared by claim and activate). */
const CLAIMED_RUN_COLUMNS = `r.run_id, r.task_id, r.attempt, r.claim_gen, r.claim_expires_at_ms,
       r.wake_event, r.event_payload,
       t.task_name, t.params, t.retry_strategy, t.max_attempts, t.headers, t.infra_retries`

/**
 * Sweep discovery scans, exported so the query-plan suite pins the EXACT
 * production SQL (the reviewed prevention: pins on stand-ins can't catch
 * drift in the queries they protect).
 */
export const SWEEP_SCAN_CANCELS_SQL = `SELECT t.task_id,
       (SELECT r.run_id FROM runs r
          WHERE r.task_id = t.task_id AND r.state IN ${LIVE}
          ORDER BY r.attempt DESC LIMIT 1) AS run_id
FROM tasks t
WHERE t.queue = ? AND t.cancel_at_ms IS NOT NULL AND t.cancel_at_ms <= ${NOW_MS}
  AND t.state IN ${LIVE}
LIMIT ?`

export const SWEEP_SCAN_EXPIRED_SQL = `SELECT r.run_id, r.task_id, r.attempt, r.claim_gen, r.activated_gen, r.relaunch_count
FROM runs r
WHERE r.queue = ? AND r.state = 'running'
  AND r.claim_expires_at_ms IS NOT NULL AND r.claim_expires_at_ms <= ${NOW_MS}
ORDER BY r.claim_expires_at_ms, r.run_id
LIMIT ?`

/** Bounded-concurrency map preserving order (sweep pipelining — the fencing
 * discipline requires per-item atomicity, never sequential issuance). */
const SWEEP_PIPELINE_WIDTH = 8
async function mapLimit<T, R>(
  items: T[],
  width: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * SchedulerStore on SQLite/libsql (DESIGN.md §3.4). Every method is ONE
 * atomic labeled batch; single-item transitions go through FencedBatch so
 * follow-ons structurally key on the batch's own stamp (§3.4 rule 1); all
 * timestamps come from NOW_MS (rule 3). "PR1.6" methods land next.
 */
export class LibsqlSchedulerStore implements SchedulerStore {
  constructor(
    private readonly db: SqlExecutor,
    private readonly ids: IdSource,
    private readonly buggify: Buggify = neverBuggify,
  ) {}

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
    const { leaseSeconds } = opts
    const limit = clampLimit(opts.limit)
    if (limit === 0) return []
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
                WHERE t.state IN ${LIVE}
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
      // 2. Task bookkeeping, keyed on the post-state + token. NOTE: attempts
      //    is deliberately NOT touched — per the TLC-checked accounting model
      //    it moves only on user-failure transitions (PR1.6 fail()), never at
      //    claim (codex finding: the earlier watermark contradicted the spec).
      {
        sql: `UPDATE tasks SET
                state = 'running',
                last_attempt_run = (
                  SELECT r.run_id FROM runs r
                  WHERE r.task_id = tasks.task_id AND r.claimed_by = ? AND r.state = 'running'
                )
              WHERE task_id IN (
                SELECT task_id FROM runs
                WHERE queue = ? AND claimed_by = ? AND state = 'running'
              )`,
        args: [claimToken, queue, claimToken],
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
      // the lease so channel-delayed launches don't start life nearly
      // expired. A launch whose task is already past its cancellation
      // deadline must not start (codex): the sweep will cancel it.
      {
        sql: `UPDATE runs SET
                activated_gen = ?,
                started_at_ms = COALESCE(started_at_ms, ${NOW_MS}),
                claim_expires_at_ms = ${NOW_MS} + lease_seconds * 1000,
                heartbeat_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
                AND claim_gen = ? AND activated_gen < ?
                AND NOT EXISTS (
                  SELECT 1 FROM tasks t
                  WHERE t.task_id = runs.task_id
                    AND t.cancel_at_ms IS NOT NULL AND t.cancel_at_ms <= ${NOW_MS}
                )`,
        args: [claimGen, runId, queue, claimToken, claimGen, claimGen],
      },
      // First-ever start stamps the task and REPLACES the deadline: max_delay
      // is disarmed by starting (its whole meaning is "cancel if never
      // started"); max_duration runs from first start. The earlier MIN() kept
      // the stale spawn deadline and cancelled healthy running tasks.
      {
        sql: `UPDATE tasks SET
                first_started_at_ms = COALESCE(first_started_at_ms, ${NOW_MS}),
                cancel_at_ms = CASE
                  WHEN json_extract(cancellation, '$.maxDurationSeconds') IS NOT NULL THEN
                    COALESCE(first_started_at_ms, ${NOW_MS})
                      + json_extract(cancellation, '$.maxDurationSeconds') * 1000
                  ELSE NULL
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
   * FencedBatch — the CAS stamps the row it kills (claimed_by carries the
   * sweep stamp; nothing reads claimed_by off non-running runs) and every
   * follow-on keys on the stamp, so a racing sweeper's whole batch matches
   * nothing structurally. One `limit` bounds TOTAL transitions across both
   * scans; per-item batches run through a bounded pipeline, never
   * sequentially (the reviewed RTT pileup).
   */
  async sweep(queue: string, limit: number): Promise<SweptRun[]> {
    const budget = clampLimit(limit)
    if (budget === 0) return []
    const effectiveBudget = budget > 1 && this.buggify('sweep:short-batch') ? 1 : budget
    const [cancels, expired] = await this.db.batch(
      'sweep:scan',
      [
        { sql: SWEEP_SCAN_CANCELS_SQL, args: [queue, effectiveBudget] },
        { sql: SWEEP_SCAN_EXPIRED_SQL, args: [queue, effectiveBudget] },
      ],
      'read',
    )

    type Item =
      | { kind: 'cancel'; taskId: string; runId: string | null }
      | {
          kind: 'expired'
          runId: string
          taskId: string
          attempt: number
          claimGen: number
          activatedGen: number
          relaunchCount: number
        }
    const items: Item[] = []
    for (const row of cancels?.rows ?? []) {
      items.push({
        kind: 'cancel',
        taskId: String(row.task_id),
        runId: row.run_id === null ? null : String(row.run_id),
      })
      if (items.length >= effectiveBudget) break
    }
    for (const row of expired?.rows ?? []) {
      if (items.length >= effectiveBudget) break
      items.push({
        kind: 'expired',
        runId: String(row.run_id),
        taskId: String(row.task_id),
        attempt: Number(row.attempt),
        claimGen: Number(row.claim_gen),
        activatedGen: Number(row.activated_gen),
        relaunchCount: Number(row.relaunch_count),
      })
    }

    const outcomes = await mapLimit(
      items,
      SWEEP_PIPELINE_WIDTH,
      (item): Promise<SweptRun | null> => {
        if (item.kind === 'cancel') {
          return this.cancelTransition('sweep:cancel', queue, item.taskId, true).then((won) =>
            won ? { kind: 'cancelled', taskId: item.taskId, runId: item.runId } : null,
          )
        }
        return item.activatedGen < item.claimGen
          ? this.sweepLostLaunch(queue, item)
          : this.sweepClaimTimeout(queue, item)
      },
    )
    return outcomes.filter((o): o is SweptRun => o !== null)
  }

  private async sweepLostLaunch(
    queue: string,
    item: { runId: string; taskId: string; claimGen: number; relaunchCount: number },
  ): Promise<SweptRun | null> {
    const fence = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?
                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW_MS}`
    const { won } = await new FencedBatch('sweep:lost-launch', this.ids.token())
      // The launch never activated: reopen the SAME run — no new row, no
      // attempt consumed — with linear backoff on the relaunch counter. The
      // stamp parks in claimed_by (nothing reads claimed_by off non-running
      // runs; the next claim overwrites it).
      .cas(
        'reopen',
        `UPDATE runs SET
           state = 'pending', claimed_by = ${STAMP}, claim_expires_at_ms = NULL,
           heartbeat_at_ms = NULL, relaunch_count = relaunch_count + 1,
           available_at_ms = ${NOW_MS}
             + MIN((relaunch_count + 1) * ${RELAUNCH_BACKOFF_BASE_SECONDS}, ${RELAUNCH_BACKOFF_MAX_SECONDS}) * 1000
         WHERE ${fence} AND relaunch_count < ${RELAUNCH_CAP}`,
        [item.runId, queue, item.claimGen],
      )
      // Past the cap: a broken launcher must surface as failed work — the
      // task fails with the run (TLA-pinned), never an infinite launch loop.
      .cas(
        'cap',
        `UPDATE runs SET
           state = 'failed', failed_at_ms = ${NOW_MS}, claimed_by = ${STAMP},
           claim_expires_at_ms = NULL, failure_reason = '${REASON_RELAUNCH_CAP}'
         WHERE ${fence} AND relaunch_count >= ${RELAUNCH_CAP}`,
        [item.runId, queue, item.claimGen],
      )
      // The task mirrors the run (the reviewed phantom-'running' divergence
      // from the TLA SweepLostLaunch action).
      .followOn(
        'task-pending',
        `UPDATE tasks SET state = 'pending'
         WHERE task_id = ? AND EXISTS (
           SELECT 1 FROM runs WHERE run_id = ? AND state = 'pending' AND claimed_by = ${STAMP}
         )`,
        [item.taskId, item.runId],
      )
      .followOn(
        'task-fail',
        `UPDATE tasks SET state = 'failed', failure_reason = '${REASON_RELAUNCH_CAP}'
         WHERE task_id = ? AND EXISTS (
           SELECT 1 FROM runs WHERE run_id = ? AND state = 'failed' AND claimed_by = ${STAMP}
         )`,
        [item.taskId, item.runId],
      )
      .followOn(
        'waits-gone',
        `DELETE FROM waits WHERE run_id = ? AND EXISTS (
           SELECT 1 FROM runs WHERE run_id = ? AND state = 'failed' AND claimed_by = ${STAMP}
         )`,
        [item.runId, item.runId],
      )
      .run(this.db)
    if (won === 'reopen') {
      return {
        kind: 'lost-launch',
        runId: item.runId,
        taskId: item.taskId,
        relaunchCount: item.relaunchCount + 1,
      }
    }
    if (won === 'cap') {
      return { kind: 'relaunch-cap-exhausted', runId: item.runId, taskId: item.taskId }
    }
    return null // lost the race to another sweeper
  }

  private async sweepClaimTimeout(
    queue: string,
    item: { runId: string; taskId: string; attempt: number; claimGen: number },
  ): Promise<SweptRun | null> {
    const successorId = this.ids.uuidv7()
    const { won, results } = await new FencedBatch('sweep:claim-timeout', this.ids.token())
      // Ownership CAS: the activated worker died (or was partitioned). The
      // stamp overwrites the dead worker's token, so its zombie writes are
      // doubly fenced from here on.
      .cas(
        'fail',
        `UPDATE runs SET
           state = 'failed', failed_at_ms = ${NOW_MS}, claimed_by = ${STAMP},
           failure_reason = '${REASON_CLAIM_TIMEOUT}'
         WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?
           AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW_MS}`,
        [item.runId, queue, item.claimGen],
      )
      // Successor under the infra cap, carrying the run-DB pointer and any
      // parked event wake (§3.8.2). Plain INSERT (not OR IGNORE — reviewed:
      // OR IGNORE also swallows PK collisions and books foreign rows): the
      // stamp guarantees only the winner reaches this statement, so a
      // constraint violation is a real invariant breach and must fail loudly.
      .followOn(
        'successor',
        `INSERT INTO runs
           (run_id, queue, task_id, attempt, state, available_at_ms,
            wake_event, event_payload, run_db, created_at_ms)
         SELECT ?, r.queue, r.task_id, ?, 'pending',
                ${NOW_MS} + ${INFRA_BACKOFF_SECONDS} * 1000,
                r.wake_event, r.event_payload, r.run_db, ${NOW_MS}
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ? AND r.state = 'failed' AND r.claimed_by = ${STAMP}
           AND t.state IN ${LIVE} AND t.infra_retries < ${INFRA_RETRY_CAP}`,
        [successorId, item.attempt + 1, item.runId],
      )
      // At the cap (pre-increment): terminal. Stamp-fenced, so the reviewed
      // losing-sweeper interleaving matches zero rows structurally.
      .followOn(
        'task-terminal',
        `UPDATE tasks SET state = 'failed', failure_reason = '${REASON_INFRA_CAP}'
         WHERE task_id = ? AND state IN ${LIVE} AND infra_retries >= ${INFRA_RETRY_CAP}
           AND EXISTS (
             SELECT 1 FROM runs WHERE run_id = ? AND state = 'failed' AND claimed_by = ${STAMP}
           )`,
        [item.taskId, item.runId],
      )
      // Bookkeeping keyed on the stamp AND our successor existing.
      .followOn(
        'bookkeeping',
        `UPDATE tasks SET
           infra_retries = infra_retries + 1, state = 'pending', last_attempt_run = ?
         WHERE task_id = ? AND state IN ${LIVE}
           AND EXISTS (
             SELECT 1 FROM runs WHERE run_id = ? AND state = 'failed' AND claimed_by = ${STAMP}
           )
           AND EXISTS (SELECT 1 FROM runs WHERE run_id = ?)`,
        [successorId, item.taskId, item.runId, successorId],
      )
      // The dead run's waits die with it (the reviewed orphan-waits leak).
      .followOn(
        'waits-gone',
        `DELETE FROM waits WHERE run_id = ? AND EXISTS (
           SELECT 1 FROM runs WHERE run_id = ? AND state = 'failed' AND claimed_by = ${STAMP}
         )`,
        [item.runId, item.runId],
      )
      .run(this.db)
    if (won !== 'fail') return null // lost the race
    return (results.successor?.rowsAffected ?? 0) === 1
      ? {
          kind: 'claim-timeout',
          runId: item.runId,
          taskId: item.taskId,
          successorRunId: successorId,
        }
      : { kind: 'infra-cap-exhausted', runId: item.runId, taskId: item.taskId }
  }

  /**
   * The single advisory write (§3.9): accelerate lease expiry, nothing more.
   * True only when it shortened a live lease. NOTE: a still-alive worker's
   * subsequent heartbeat may legitimately re-extend — the lease remains the
   * sole authority and advisory signals never revoke it.
   */
  async expireLeaseNow(queue: string, runId: string, claimToken: string): Promise<boolean> {
    const [expired] = await this.db.batch('expire-lease-now', [
      {
        sql: `UPDATE runs SET claim_expires_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
                AND claim_expires_at_ms > ${NOW_MS}`,
        args: [runId, queue, claimToken],
      },
    ])
    return (expired?.rowsAffected ?? 0) === 1
  }

  async cancelTask(queue: string, taskId: string): Promise<boolean> {
    return this.cancelTransition('cancel-task', queue, taskId, false)
  }

  /**
   * Shared cancel transition. Two labels — 'cancel-task' (explicit API) and
   * 'sweep:cancel' (deadline enforcement) — because a label is the crash
   * injection/tracing address and one label must not cover two SQL shapes.
   * The stamp lives in failure_reason (tasks have no free stamp column).
   */
  private async cancelTransition(
    label: 'cancel-task' | 'sweep:cancel',
    queue: string,
    taskId: string,
    deadlineOnly: boolean,
  ): Promise<boolean> {
    const deadlineGuard = deadlineOnly
      ? `AND cancel_at_ms IS NOT NULL AND cancel_at_ms <= ${NOW_MS}`
      : ''
    const { won } = await new FencedBatch(label, this.ids.token())
      .cas(
        'cancel',
        `UPDATE tasks SET
           state = 'cancelled', cancelled_at_ms = ${NOW_MS}, cancel_at_ms = NULL,
           failure_reason = json_object('name', '$Cancelled', 'stamp', ${STAMP})
         WHERE task_id = ? AND queue = ? AND state IN ${LIVE} ${deadlineGuard}`,
        [taskId, queue],
      )
      .followOn(
        'runs',
        `UPDATE runs SET state = 'cancelled', claimed_by = NULL, claim_expires_at_ms = NULL
         WHERE task_id = ? AND state IN ${LIVE} AND EXISTS (
           SELECT 1 FROM tasks
           WHERE task_id = ? AND json_extract(failure_reason, '$.stamp') = ${STAMP}
         )`,
        [taskId, taskId],
      )
      .followOn(
        'waits',
        `DELETE FROM waits WHERE task_id = ? AND EXISTS (
           SELECT 1 FROM tasks
           WHERE task_id = ? AND json_extract(failure_reason, '$.stamp') = ${STAMP}
         )`,
        [taskId, taskId],
      )
      .run(this.db)
    return won === 'cancel'
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

/** SQLite parses LIMIT -1 as unlimited (reviewed): clamp and floor. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new RangeError(`limit ${limit}`)
  return Math.max(0, Math.floor(limit))
}

function notYet(method: string): Promise<never> {
  return Promise.reject(new Error(`LibsqlSchedulerStore.${method}: not implemented until PR1.6`))
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

import {
  type Buggify,
  type Checkpoint,
  type ClaimedRun,
  durationToMs,
  FENCE_COLS,
  FENCE_SET,
  FENCE_VALS,
  FencedBatch,
  INFRA_BACKOFF_SECONDS,
  INFRA_RETRY_CAP,
  LeaseLostError,
  NOW,
  requireEpochMs,
  requirePositiveInt,
  type IdSource,
  type LeaseState,
  neverBuggify,
  normalizeRetryStrategy,
  REASON_CANCELLED,
  REASON_CLAIM_TIMEOUT,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_BACKOFF_MAX_SECONDS,
  RELAUNCH_CAP,
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
import {
  cancelDue,
  eligibleTask,
  fenceFrom,
  fenced,
  fencedAt,
  LIVE,
  successor,
} from './fragments.js'
import { NOW_MS } from './time.js'

const DEFAULT_RETRY: RetryStrategy = {
  kind: 'exponential',
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 3600,
}
const DEFAULT_MAX_ATTEMPTS = 5

/**
 * Attempt counters DERIVED from a stamped run's ordinal, never bumped
 * (`x = x + 1` is not idempotent in a follow-on: an exact batch replay
 * re-matches its own stamped row and counts twice — FencedBatch rejects that
 * shape). run.attempt counts EVERY successor; infra_retries counts the
 * infrastructure ones; the user ordinal is the difference. One definition
 * each, used at every site.
 */
const USER_ATTEMPTS_FROM = (runIdParam: string, fence: string): string =>
  `(SELECT f.attempt - tasks.infra_retries FROM runs f
    WHERE f.run_id = ${runIdParam} AND f.fence_stamp = ${fence})`
const INFRA_RETRIES_FROM = (successorParam: string, fence: string): string =>
  `(SELECT f.attempt - 1 - tasks.attempts FROM runs f
    WHERE f.run_id = ${successorParam} AND f.fence_stamp = ${fence})`

/** A run's own row, by id — the correlation every fence in this file uses. */
const BY_RUN = `f.run_id = ?`

/** Columns needed to decode a ClaimedRun (shared by claim and activate). */
const CLAIMED_RUN_COLUMNS = `r.run_id, r.task_id, r.attempt, r.claim_gen, r.claim_expires_at_ms, r.lease_ms,
       r.wake_event, r.event_payload, r.wake_step,
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
WHERE t.queue = ? AND ${cancelDue('t.cancel_at_ms', NOW_MS)}
  AND t.state IN ${LIVE}
ORDER BY t.cancel_at_ms, t.task_id
LIMIT ?`

export const NEXT_WAKE_SQL = `SELECT MIN(v) AS wake_ms FROM (
  SELECT MIN(available_at_ms) AS v FROM runs
    WHERE queue = ? AND state = 'pending' AND available_at_ms IS NOT NULL
  UNION ALL
  SELECT MIN(available_at_ms) FROM runs
    WHERE queue = ? AND state = 'sleeping' AND available_at_ms IS NOT NULL
  UNION ALL
  SELECT MIN(claim_expires_at_ms) FROM runs
    WHERE queue = ? AND state = 'running' AND claim_expires_at_ms IS NOT NULL
  UNION ALL
  SELECT MIN(cancel_at_ms) FROM tasks
    WHERE queue = ? AND cancel_at_ms IS NOT NULL AND state IN ${LIVE}
)`

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
 * timestamps come from NOW_MS (rule 3).
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
    const maxAttempts = requirePositiveInt('maxAttempts', opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    const delayMs = durationToMs('startDelaySeconds', opts.startDelaySeconds ?? 0)
    const maxDelayMs =
      opts.cancellation?.maxDelaySeconds !== undefined
        ? durationToMs('cancellation.maxDelaySeconds', opts.cancellation.maxDelaySeconds)
        : null
    // maxDurationSeconds is stored in the cancellation JSON and applied at
    // activate — validate it HERE so garbage never reaches the column.
    if (opts.cancellation?.maxDurationSeconds !== undefined) {
      durationToMs('cancellation.maxDurationSeconds', opts.cancellation.maxDurationSeconds)
    }

    const key = opts.idempotencyKey ?? null
    const b = new FencedBatch('spawn', this.ids.token(), { now: NOW_MS })
    // Idempotent task insert: loses silently when the key already exists.
    // enqueue/cancel deadlines are computed in SQL (rule 3); cancel_at_ms
    // materializes max_delay so sweeps and nextWakeAt are indexed reads, never
    // JSON scans.
    //
    // The NOT EXISTS on the primary key is what makes this a compare-and-set
    // rather than a crash: the targeted ON CONFLICT covers the idempotency
    // index only, so a colliding task_id raised a constraint error out of
    // spawn instead of losing. Losing is the right answer — some other task
    // already occupies that identity — and it is one the batch can reason
    // about.
    b.cas(
      'task',
      'tasks',
      `INSERT INTO tasks (task_id, queue, task_name, params, headers, retry_strategy,
         max_attempts, cancellation, idempotency_key, state, enqueue_at_ms,
         cancel_at_ms, created_at_ms, ${FENCE_COLS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ${NOW} + ?,
         CASE WHEN ? IS NOT NULL THEN ${NOW} + ? + ? ELSE NULL END,
         ${NOW}, ${FENCE_VALS}
       WHERE NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)
       ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [
        taskId,
        queue,
        taskName,
        paramsJson,
        opts.headers ? JSON.stringify(opts.headers) : null,
        retry,
        maxAttempts,
        opts.cancellation ? JSON.stringify(opts.cancellation) : null,
        key,
        delayMs,
        maxDelayMs,
        delayMs,
        maxDelayMs,
        taskId,
      ],
    )
    // The initial run, for the task THIS batch just created. Two guards the
    // old version needed have deleted themselves: the task cannot be terminal
    // (we inserted it 'pending' one statement ago) and cannot already have a
    // run (it did not exist one statement ago). Both were only there because
    // the statement could not tell whose task it was looking at.
    b.followOn(
      'run',
      'runs',
      `INSERT INTO runs (run_id, queue, task_id, attempt, state,
         available_at_ms, created_at_ms, ${FENCE_COLS})
       SELECT ?, f.queue, f.task_id, 1, 'pending', f.enqueue_at_ms, f.fence_at_ms,
         ${STAMP}, f.fence_at_ms
       FROM tasks f WHERE f.task_id = ? AND f.fence_stamp = ${b.fence('task')}`,
      [runId, taskId],
      'one',
    )
    // Only reached when the insert lost, so by definition it reads a task some
    // OTHER caller created — fenced by the unique (queue, idempotency_key)
    // index, not by this batch's stamp. Ordering prefers the idempotency
    // winner over a bare id collision and breaks ties on task_id, so it is
    // deterministic on every dialect; an `ORDER BY (t.task_id = ?) DESC` would
    // not be, since Postgres sorts NULLs first.
    b.openTail(
      'receipt',
      'the winner is a task another caller created; the unique idempotency index is its fence, not this batch stamp',
      `SELECT t.task_id AS task_id,
              (SELECT r.run_id FROM runs r WHERE r.task_id = t.task_id
                 ORDER BY r.attempt DESC, r.run_id DESC LIMIT 1) AS run_id
       FROM tasks t
       WHERE t.task_id = ? OR (? IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?)
       ORDER BY CASE WHEN ? IS NOT NULL AND t.idempotency_key = ? THEN 0 ELSE 1 END, t.task_id
       LIMIT 1`,
      [taskId, key, queue, key, key, key],
    )
    const { won, results } = await b.run(this.db)
    if (won === 'task') return { taskId, runId, created: true }

    const row = results.receipt?.rows[0]
    if (!row) throw new Error('spawn: the task insert lost but no existing task explains it')
    // A pre-existing task may legitimately have no run — swept away, or never
    // given one. There is no honest run id to report then, and the previous
    // version reported the one it had minted and never inserted, so every
    // poll on it found nothing forever.
    return {
      taskId: String(row.task_id),
      runId: row.run_id === null ? null : String(row.run_id),
      created: false,
    }
  }

  async claim(
    queue: string,
    claimToken: string,
    opts: { leaseSeconds: number; limit: number },
  ): Promise<ClaimedRun[]> {
    const leaseMs = durationToMs('leaseSeconds', opts.leaseSeconds, { positive: true })
    const limit = clampLimit(requirePositiveInt('limit', opts.limit))
    if (limit === 0) return []
    // Buggify: a short claim is always legal (limit is a maximum) — ticks
    // must drain via the successor-tick chain, never assume a full batch.
    const effectiveLimit = limit > 1 && this.buggify('claim:short-batch') ? 1 : limit
    const b = new FencedBatch('claim', this.ids.token(), { now: NOW_MS })
    // Due runs of live tasks → running, holding the caller's lease token AND
    // this batch's provenance. The two are now different things, which is the
    // point: the token survives the batch by contract (the worker keeps
    // working), so it cannot tell one delivery of a claim from another. The
    // candidate subselect is unchanged — a bounded per-state UNION so each leg
    // is an ordered covering-index scan of at most K rows rather than a temp
    // b-tree over the backlog, a shape the query-plan suite pins. The
    // generation bump is safe here because the CAS's own guard consumes the
    // pre-state.
    b.casMany(
      'claim',
      'runs',
      effectiveLimit,
      `UPDATE runs SET
         state = 'running',
         claimed_by = ?,
         claim_gen = claim_gen + 1,
         lease_ms = ?,
         claim_expires_at_ms = ${NOW} + ?,
         heartbeat_at_ms = ${NOW},
         ${FENCE_SET}
       WHERE run_id IN (
         SELECT c.run_id FROM (
           SELECT * FROM (
             SELECT r.run_id, r.available_at_ms FROM runs r
             WHERE r.queue = ? AND r.state = 'pending'
               AND r.available_at_ms IS NOT NULL AND r.available_at_ms <= ${NOW}
             ORDER BY r.available_at_ms, r.run_id LIMIT ?
           )
           UNION ALL
           SELECT * FROM (
             SELECT r.run_id, r.available_at_ms FROM runs r
             WHERE r.queue = ? AND r.state = 'sleeping'
               AND r.available_at_ms IS NOT NULL AND r.available_at_ms <= ${NOW}
             ORDER BY r.available_at_ms, r.run_id LIMIT ?
           )
         ) c
         JOIN runs cr ON cr.run_id = c.run_id
         JOIN tasks t ON t.task_id = cr.task_id
         WHERE ${eligibleTask('t', NOW)}
         ORDER BY c.available_at_ms, c.run_id
         LIMIT ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM runs held
         WHERE held.queue = ? AND held.state = 'running' AND held.claimed_by = ?
       )`,
      [
        claimToken,
        leaseMs,
        leaseMs,
        queue,
        effectiveLimit,
        queue,
        effectiveLimit,
        effectiveLimit,
        queue,
        claimToken,
      ],
    )
    const claimedByThisBatch = `SELECT r.task_id FROM runs r
                                WHERE r.queue = ? AND r.state = 'running'
                                  AND r.fence_stamp = ${b.fence('claim')}`
    // attempts is deliberately NOT touched: per the accounting model it moves
    // only on user-failure transitions, never at claim.
    b.followOn(
      'task-book',
      'tasks',
      `UPDATE tasks SET
         state = 'running',
         last_attempt_run = (SELECT f.run_id FROM runs f
                             WHERE f.task_id = tasks.task_id
                               AND f.fence_stamp = ${b.fence('claim')}),
         fence_stamp = ${STAMP},
         fence_at_ms = (SELECT f.fence_at_ms FROM runs f
                        WHERE f.task_id = tasks.task_id
                          AND f.fence_stamp = ${b.fence('claim')})
       WHERE state IN ${LIVE} AND task_id IN (${claimedByThisBatch})`,
      [queue],
      { many: 'one task per claimed run' },
    )
    // A timed-out waiter's claim consumes its wait row, so a later emit cannot
    // resurrect a timed-out wait (§3.4 rule 2, timeout branch). Both halves
    // changed. It used to select rows by the caller's token, which a DUPLICATE
    // delivery of the same claim also matches even though its own CAS
    // correctly took nothing — and it then compared their deadlines against a
    // FRESH clock read, so waits that fell due between the two deliveries were
    // deleted by the delivery that had claimed nothing. Now it sees only rows
    // this batch stamped, and compares against the instant that batch
    // recorded.
    b.followOn(
      'waits-timeout',
      `DELETE FROM waits
       WHERE run_id IN (SELECT r.run_id FROM runs r
                        WHERE r.queue = ? AND r.state = 'running'
                          AND r.fence_stamp = ${b.fence('claim')})
         AND status = 'waiting'
         AND timeout_at_ms IS NOT NULL
         AND timeout_at_ms <= ${fencedAt('runs', `f.run_id = waits.run_id`, b.fence('claim'))}`,
      [queue],
      { many: 'a run may hold several timed waits' },
    )
    // Deliberately keyed on the LEASE token, not this batch's stamp: §3.4
    // rule 4 makes a same-token claim an idempotent receipt that returns the
    // ORIGINAL selection, so this read must see rows a PREVIOUS batch stamped.
    // Only LIVE tasks, so a terminal task's corrupt running run is never
    // launched.
    b.openTail(
      'picked',
      'rule 4: a same-token retry is a receipt and must return the original selection, which a previous batch stamped',
      `SELECT ${CLAIMED_RUN_COLUMNS}
       FROM runs r JOIN tasks t ON t.task_id = r.task_id
       WHERE r.queue = ? AND r.claimed_by = ? AND r.state = 'running'
         AND t.state IN ${LIVE}
       ORDER BY r.run_id`,
      [queue, claimToken],
    )
    const { results } = await b.run(this.db)
    return (results.picked?.rows ?? []).map((row) => decodeClaimedRun(row, claimToken))
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
    const b = new FencedBatch('activate', this.ids.token(), { now: NOW_MS })
    // Per-claim latch: only this claim's first delivery passes; re-extends
    // the lease so channel-delayed launches don't start life nearly expired.
    // A launch whose task is already past its cancellation deadline must not
    // start: the sweep will cancel it. claimed_by is deliberately left alone —
    // the worker keeps its lease — which is exactly the freedom the batch
    // needed and did not have while claimed_by was also the stamp.
    b.cas(
      'activate',
      'runs',
      `UPDATE runs SET
         activated_gen = ?,
         started_at_ms = COALESCE(started_at_ms, ${NOW}),
         claim_expires_at_ms = ${NOW} + lease_ms,
         heartbeat_at_ms = ${NOW},
         ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND claim_gen = ? AND activated_gen < ?
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.task_id = runs.task_id AND ${eligibleTask('t', NOW)}
         )`,
      [claimGen, runId, queue, claimToken, claimGen, claimGen],
    )
    // First-ever start stamps the task and REPLACES the deadline: max_delay is
    // disarmed by starting (its whole meaning is "cancel if never started");
    // max_duration runs from first start. The earlier MIN() kept the stale
    // spawn deadline and cancelled healthy running tasks.
    //
    // Fencing on this batch's own stamp is what makes that safe. The previous
    // fence was (claimed_by, activated_gen) — values the WINNER wrote — so a
    // losing duplicate delivery matched the very row the winner had just
    // updated and re-ran this statement, whose ELSE arm clears cancel_at_ms.
    // A task with an armed start deadline and no max-duration clause had that
    // deadline silently disarmed by a delivery that had already been refused,
    // and was then never cancelled.
    const activated = fencedAt('runs', BY_RUN, b.fence('activate'))
    b.followOn(
      'task-start',
      'tasks',
      `UPDATE tasks SET
         first_started_at_ms = COALESCE(first_started_at_ms, ${activated}),
         cancel_at_ms = CASE
           WHEN json_extract(cancellation, '$.maxDurationSeconds') IS NOT NULL THEN
             CAST(COALESCE(first_started_at_ms, ${activated})
               + json_extract(cancellation, '$.maxDurationSeconds') * 1000 AS INTEGER)
           ELSE NULL
         END,
         ${fenceFrom('runs', BY_RUN, b.fence('activate'))}
       WHERE state IN ${LIVE}
         AND task_id = (SELECT f.task_id FROM runs f
                        WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('activate')})`,
      [runId, runId, runId, runId],
      'one',
    )
    // Full payload for the winning worker. Fenced, so it can only return the
    // row THIS delivery activated — the post-state alone cannot tell "I won"
    // from "a previous delivery of the same claim won", since both leave
    // activated_gen equal to claim_gen.
    b.tail(
      'payload',
      `SELECT ${CLAIMED_RUN_COLUMNS}
       FROM runs r JOIN tasks t ON t.task_id = r.task_id
       WHERE r.run_id = ? AND r.fence_stamp = ${b.fence('activate')} AND r.state = 'running'`,
      [runId],
    )
    const { won, results } = await b.run(this.db)
    if (won !== 'activate') return null
    const row = results.payload?.rows[0]
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
    const extendMs = durationToMs('extendSeconds', extendSeconds, { positive: true })
    // ONE statement. It was two — the extend, then a SELECT computing
    // `claim_expires_at_ms - <clock>` — which read the clock twice in one
    // batch, so the answer was off by however far the two reads drifted.
    // RETURNING makes the row count the proof that the lease was extended and
    // computes the remainder in the same statement, where the clock is stable.
    // A batch of one statement cannot have the two-clock-reads problem at all,
    // which is a better guarantee than getting the arithmetic right.
    const [extended] = await this.db.batch('heartbeat', [
      {
        sql: `UPDATE runs SET
                claim_expires_at_ms = ${NOW_MS} + ?,
                heartbeat_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
                AND EXISTS (SELECT 1 FROM tasks t
                            WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})
              RETURNING claim_expires_at_ms - heartbeat_at_ms AS remaining_ms`,
        args: [extendMs, runId, queue, claimToken],
      },
    ])
    const row = extended?.rows[0]
    if (!row) return { held: false, remainingMs: 0 }
    return { held: true, remainingMs: Number(row.remaining_ms) }
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
    const b = new FencedBatch('sweep:lost-launch', this.ids.token(), { now: NOW_MS })
    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?
                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW}`
    // The launch never activated: reopen the SAME run — no new row, no
    // attempt consumed — with linear backoff on the relaunch counter. The
    // counter bump is safe in a CAS: its guard consumes the 'running' state,
    // so a replay matches nothing and cannot bump twice.
    b.cas(
      'reopen',
      'runs',
      `UPDATE runs SET
         state = 'pending', claimed_by = NULL, claim_expires_at_ms = NULL,
         heartbeat_at_ms = NULL, relaunch_count = relaunch_count + 1,
         available_at_ms = ${NOW}
           + MIN((relaunch_count + 1) * ${RELAUNCH_BACKOFF_BASE_SECONDS}, ${RELAUNCH_BACKOFF_MAX_SECONDS}) * 1000,
         ${FENCE_SET}
       WHERE ${guard} AND relaunch_count < ${RELAUNCH_CAP}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})`,
      [item.runId, queue, item.claimGen],
    )
    // Past the cap: a broken launcher must surface as failed work — the
    // task fails with the run (TLA-pinned), never an infinite launch loop.
    b.cas(
      'cap',
      'runs',
      `UPDATE runs SET
         state = 'failed', failed_at_ms = ${NOW}, claimed_by = NULL,
         claim_expires_at_ms = NULL, failure_reason = ?, ${FENCE_SET}
       WHERE ${guard} AND relaunch_count >= ${RELAUNCH_CAP}`,
      [REASON_RELAUNCH_CAP, item.runId, queue, item.claimGen],
    )
    // The task mirrors the run (the reviewed phantom-'running' divergence
    // from the TLA SweepLostLaunch action). Each arm names the CAS it
    // follows, so neither can fire for the other's outcome.
    b.followOn(
      'task-pending',
      'tasks',
      `UPDATE tasks SET state = 'pending', ${fenceFrom('runs', BY_RUN, b.fence('reopen'))}
       WHERE task_id = ? AND state IN ${LIVE} AND ${fenced('runs', BY_RUN, b.fence('reopen'))}`,
      [item.runId, item.taskId, item.runId],
      'one',
    )
    b.followOn(
      'task-fail',
      'tasks',
      `UPDATE tasks SET state = 'failed', failure_reason = ?,
         ${fenceFrom('runs', BY_RUN, b.fence('cap'))}
       WHERE task_id = ? AND state IN ${LIVE} AND ${fenced('runs', BY_RUN, b.fence('cap'))}`,
      [REASON_RELAUNCH_CAP, item.runId, item.taskId, item.runId],
      'one',
    )
    b.followOn(
      'waits-gone',
      `DELETE FROM waits WHERE run_id = ? AND ${fenced('runs', BY_RUN, b.fence('cap'))}`,
      [item.runId, item.runId],
      { many: 'a run may hold several waits' },
    )
    const { won } = await b.run(this.db)
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
    const b = new FencedBatch('sweep:claim-timeout', this.ids.token(), { now: NOW_MS })
    // Ownership CAS: the activated worker died (or was partitioned). Clearing
    // claimed_by kills the dead worker's token, so its zombie writes are
    // doubly fenced from here on.
    b.cas(
      'fail',
      'runs',
      `UPDATE runs SET
         state = 'failed', failed_at_ms = ${NOW}, claimed_by = NULL,
         failure_reason = ?, ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?
         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}`,
      [REASON_CLAIM_TIMEOUT, item.runId, queue, item.claimGen],
    )
    // Successor under the infra cap, carrying the run-DB pointer and any
    // parked event wake (§3.8.2). Plain INSERT (not OR IGNORE — reviewed: OR
    // IGNORE also swallows PK collisions and books foreign rows), so a
    // collision with a FOREIGN row still fails loudly. Its instant is the
    // failed run's, so the backoff is measured from the moment of death and
    // not from a second clock read.
    b.followOn(
      'successor',
      'runs',
      `INSERT INTO runs
         (run_id, queue, task_id, attempt, state, available_at_ms,
          wake_event, event_payload, wake_step, run_db, created_at_ms, ${FENCE_COLS})
       SELECT ?, f.queue, f.task_id, ?, 'pending',
              f.fence_at_ms + ${INFRA_BACKOFF_SECONDS} * 1000,
              f.wake_event, f.event_payload, f.wake_step, f.run_db, f.fence_at_ms,
              ${STAMP}, f.fence_at_ms
       FROM runs f JOIN tasks t ON t.task_id = f.task_id
       WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('fail')}
         AND t.state IN ${LIVE} AND t.infra_retries < ${INFRA_RETRY_CAP}
         AND NOT ${successor.mine('?', 'f.task_id')}`,
      [successorId, item.attempt + 1, item.runId, successorId],
      'one',
    )
    // At the cap (pre-increment): terminal. Terminal ONLY when this batch
    // actually failed to place a successor — keying on the cap alone made an
    // exact replay terminalize the task over the successor the first pass had
    // just created (rule 6).
    b.followOn(
      'task-terminal',
      'tasks',
      `UPDATE tasks SET state = 'failed', failure_reason = ?,
         ${fenceFrom('runs', BY_RUN, b.fence('fail'))}
       WHERE task_id = ? AND state IN ${LIVE} AND infra_retries >= ${INFRA_RETRY_CAP}
         AND ${fenced('runs', BY_RUN, b.fence('fail'))}
         AND NOT ${successor.exists('?', 'tasks.task_id', '?')}`,
      [REASON_INFRA_CAP, item.runId, item.taskId, item.runId, successorId, item.runId],
      'one',
    )
    // Bookkeeping keyed on our successor existing. The counter DERIVES from
    // the successor's own attempt ordinal rather than incrementing:
    // run.attempt counts every successor (user + infra), so infra = attempt -
    // 1 - user attempts. Applying this twice is the same as applying it once,
    // so an exact replay cannot double-count.
    b.followOn(
      'bookkeeping',
      'tasks',
      `UPDATE tasks SET
         infra_retries = ${INFRA_RETRIES_FROM('?', b.fence('successor'))},
         state = 'pending', last_attempt_run = ?,
         ${fenceFrom('runs', BY_RUN, b.fence('successor'))}
       WHERE task_id = ? AND state IN ${LIVE}
         AND ${fenced('runs', BY_RUN, b.fence('successor'))}`,
      [successorId, successorId, successorId, item.taskId, successorId],
      'one',
    )
    // The dead run's waits die with it (the reviewed orphan-waits leak).
    b.followOn(
      'waits-gone',
      `DELETE FROM waits WHERE run_id = ? AND ${fenced('runs', BY_RUN, b.fence('fail'))}`,
      [item.runId, item.runId],
      { many: 'a run may hold several waits' },
    )
    const { won, results } = await b.run(this.db)
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

  /**
   * Observability only: upsert this driver's liveness row. Nothing in the
   * protocol reads it — operators (and later, ops tooling) see the fleet.
   * Replay-safe: re-applying the same beat is the same row.
   */
  async driverHeartbeat(queue: string, driverId: string, ttlSeconds: number): Promise<void> {
    const ttlMs = durationToMs('ttlSeconds', ttlSeconds, { positive: true })
    await this.db.batch('driver-heartbeat', [
      {
        sql: `INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
              VALUES (?, ?, ${NOW_MS}, ${NOW_MS} + ?)
              ON CONFLICT (queue, driver_id) DO UPDATE SET
                last_beat_ms = excluded.last_beat_ms,
                expires_at_ms = excluded.expires_at_ms`,
        args: [queue, driverId, ttlMs],
      },
      // Self-cleaning: every beat also buries the expired (a fresh id per
      // process restart must not grow the table forever — bounds are
      // invariants too).
      {
        sql: `DELETE FROM drivers WHERE expires_at_ms < ${NOW_MS}`,
        args: [],
      },
    ])
  }

  async cancelTask(queue: string, taskId: string): Promise<boolean> {
    return this.cancelTransition('cancel-task', queue, taskId, false)
  }

  /**
   * Shared cancel transition. Two labels — 'cancel-task' (explicit API) and
   * 'sweep:cancel' (deadline enforcement) — because a label is the crash
   * injection/tracing address and one label must not cover two SQL shapes.
   *
   * The stamp used to be packed into failure_reason as JSON, because tasks
   * had no column of their own; the follow-ons then read it back out with
   * json_extract. That made a user-visible field carry engine bookkeeping and
   * put a JSON parse on the fence path. Both are gone.
   */
  private async cancelTransition(
    label: 'cancel-task' | 'sweep:cancel',
    queue: string,
    taskId: string,
    deadlineOnly: boolean,
  ): Promise<boolean> {
    const b = new FencedBatch(label, this.ids.token(), { now: NOW_MS })
    const deadlineGuard = deadlineOnly ? `AND ${cancelDue('cancel_at_ms', NOW)}` : ''
    const BY_TASK = `f.task_id = ?`
    b.cas(
      'cancel',
      'tasks',
      `UPDATE tasks SET
         state = 'cancelled', cancelled_at_ms = ${NOW}, cancel_at_ms = NULL,
         failure_reason = ?, ${FENCE_SET}
       WHERE task_id = ? AND queue = ? AND state IN ${LIVE} ${deadlineGuard}`,
      [REASON_CANCELLED, taskId, queue],
    )
    b.followOn(
      'runs',
      'runs',
      `UPDATE runs SET state = 'cancelled', claimed_by = NULL, claim_expires_at_ms = NULL,
         ${fenceFrom('tasks', BY_TASK, b.fence('cancel'))}
       WHERE task_id = ? AND state IN ${LIVE} AND ${fenced('tasks', BY_TASK, b.fence('cancel'))}`,
      [taskId, taskId, taskId],
      { many: 'a cancelled task kills every run it still has' },
    )
    b.followOn(
      'waits',
      `DELETE FROM waits WHERE task_id = ? AND ${fenced('tasks', BY_TASK, b.fence('cancel'))}`,
      [taskId, taskId],
      { many: 'a task may hold several waits' },
    )
    const { won } = await b.run(this.db)
    return won === 'cancel'
  }

  /**
   * Sleep, defer, or attempt-neutral chain (§3.2). The worker's own claim
   * token is the ownership proof; the transition mints a fresh stamp into
   * claimed_by so the suspended run carries no live token (a zombie's later
   * writes die on claimed_by). Throws LeaseLostError when the fence lost —
   * the AB002 signal.
   */
  async reschedule(
    queue: string,
    runId: string,
    claimToken: string,
    wake: { inSeconds: number } | { atEpochMs: number },
    wakeDisposition: 'consume' | 'preserve' = 'consume',
  ): Promise<void> {
    const wakeExpr = 'inSeconds' in wake ? `${NOW_MS} + ?` : `?`
    const wakeArg =
      'inSeconds' in wake
        ? durationToMs('wake.inSeconds', wake.inSeconds)
        : requireEpochMs('wake.atEpochMs', wake.atEpochMs)
    // ONE SQL shape for both dispositions (a label is a crash-injection
    // address; the CASE keeps 'reschedule' one shape). 'preserve' is the
    // §3.8.2 deferral path: an undispatchable claim consumes nothing.
    const b = new FencedBatch('reschedule', this.ids.token(), { now: NOW_MS })
    b.cas(
      'suspend',
      'runs',
      `UPDATE runs SET
         state = CASE WHEN ${wakeExpr} <= ${NOW} THEN 'pending' ELSE 'sleeping' END,
         available_at_ms = ${wakeExpr},
         wake_event = CASE WHEN ? = 'preserve' THEN wake_event ELSE NULL END,
         event_payload = CASE WHEN ? = 'preserve' THEN event_payload ELSE NULL END,
         wake_step = CASE WHEN ? = 'preserve' THEN wake_step ELSE NULL END,
         claimed_by = NULL, claim_expires_at_ms = NULL, heartbeat_at_ms = NULL,
         ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})`,
      [
        wakeArg,
        wakeArg,
        wakeDisposition,
        wakeDisposition,
        wakeDisposition,
        runId,
        queue,
        claimToken,
      ],
    )
    // The task mirrors the run's suspension state (LIVE-guarded: rule 6).
    b.followOn(
      'task-mirror',
      'tasks',
      `UPDATE tasks SET
         state = (SELECT f.state FROM runs f WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('suspend')}),
         ${fenceFrom('runs', BY_RUN, b.fence('suspend'))}
       WHERE task_id = (SELECT f.task_id FROM runs f
                        WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('suspend')})
         AND state IN ${LIVE}`,
      [runId, runId, runId],
      'one',
    )
    const { won } = await b.run(this.db)
    if (won !== 'suspend') throw new LeaseLostError(`reschedule ${runId}`)
  }

  /**
   * The atomic suspend: reschedule's exact transition PLUS the suspension
   * marker, in one batch — the marker commits only if the park does. The
   * checkpoint keys on the batch's own stamp (the post-transition state),
   * so a lost fence writes neither.
   */
  async suspendRun(
    queue: string,
    runId: string,
    claimToken: string,
    wake: { inSeconds: number } | { atEpochMs: number },
    checkpoint: { key: string; stateJson: string },
  ): Promise<void> {
    const wakeExpr = 'inSeconds' in wake ? `${NOW_MS} + ?` : `?`
    const wakeArg =
      'inSeconds' in wake
        ? durationToMs('wake.inSeconds', wake.inSeconds)
        : requireEpochMs('wake.atEpochMs', wake.atEpochMs)
    const b = new FencedBatch('suspend', this.ids.token(), { now: NOW_MS })
    b.cas(
      'suspend',
      'runs',
      `UPDATE runs SET
         state = CASE WHEN ${wakeExpr} <= ${NOW} THEN 'pending' ELSE 'sleeping' END,
         available_at_ms = ${wakeExpr},
         wake_event = NULL, event_payload = NULL, wake_step = NULL,
         claimed_by = NULL, claim_expires_at_ms = NULL, heartbeat_at_ms = NULL,
         ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.task_id = runs.task_id AND ${eligibleTask('t', NOW)})`,
      [wakeArg, wakeArg, runId, queue, claimToken],
    )
    // The marker's timestamp is the park's instant, taken from the row the
    // CAS stamped. This was the one follow-on with a legitimate need for the
    // batch's clock, and the reason fence_at_ms is a column rather than a
    // convention: without it, this statement would be a standing exemption to
    // "a follow-on may not read the clock".
    b.followOn(
      'marker',
      `INSERT INTO checkpoints
         (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
       SELECT f.task_id, ?, f.queue, ?, f.run_id, f.attempt, f.fence_at_ms
       FROM runs f WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('suspend')}
       ON CONFLICT (task_id, checkpoint_name) DO UPDATE SET
         state = excluded.state,
         owner_run_id = excluded.owner_run_id,
         owner_attempt = excluded.owner_attempt,
         updated_at_ms = excluded.updated_at_ms
       WHERE excluded.owner_attempt >= checkpoints.owner_attempt`,
      [checkpoint.key, checkpoint.stateJson, runId],
      'one',
    )
    b.followOn(
      'task-mirror',
      'tasks',
      `UPDATE tasks SET
         state = (SELECT f.state FROM runs f WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('suspend')}),
         ${fenceFrom('runs', BY_RUN, b.fence('suspend'))}
       WHERE task_id = (SELECT f.task_id FROM runs f
                        WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('suspend')})
         AND state IN ${LIVE}`,
      [runId, runId, runId],
      'one',
    )
    const { won } = await b.run(this.db)
    if (won !== 'suspend') throw new LeaseLostError(`suspendRun ${runId}`)
  }

  async complete(
    queue: string,
    runId: string,
    claimToken: string,
    resultJson: string,
  ): Promise<void> {
    const b = new FencedBatch('complete', this.ids.token(), { now: NOW_MS })
    b.cas(
      'complete',
      'runs',
      `UPDATE runs SET
         state = 'completed', completed_at_ms = ${NOW}, result = ?,
         wake_event = NULL, event_payload = NULL, wake_step = NULL,
         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'`,
      [resultJson, runId, queue, claimToken],
    )
    b.followOn(
      'task',
      'tasks',
      `UPDATE tasks SET state = 'completed', completed_payload = ?, cancel_at_ms = NULL,
         ${fenceFrom('runs', BY_RUN, b.fence('complete'))}
       WHERE task_id = (SELECT f.task_id FROM runs f
                        WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('complete')})
         AND state IN ${LIVE}`,
      [resultJson, runId, runId],
      'one',
    )
    b.followOn(
      'waits-gone',
      `DELETE FROM waits WHERE run_id = ? AND ${fenced('runs', BY_RUN, b.fence('complete'))}`,
      [runId, runId],
      { many: 'a run may hold several waits' },
    )
    const { won } = await b.run(this.db)
    if (won !== 'complete') throw new LeaseLostError(`complete ${runId}`)
  }

  /**
   * User-code failure. Retry POLICY is decided by the caller (core's
   * decideRetry over the user ordinal); the store applies the fenced
   * transition. This is the ONLY place tasks.attempts moves (the TLC-checked
   * AttemptAccounting shape). A retrying failure inserts the successor run
   * (attempt+1, carrying wake_event/event_payload/run_db) in the same batch.
   */
  async fail(
    queue: string,
    runId: string,
    claimToken: string,
    failureJson: string,
    retry: { delaySeconds: number } | null,
  ): Promise<void> {
    const successorId = retry ? this.ids.uuidv7() : null
    const retryDelayMs = retry ? durationToMs('retry.delaySeconds', retry.delaySeconds) : null
    const b = new FencedBatch('fail', this.ids.token(), { now: NOW_MS })
    b.cas(
      'fail',
      'runs',
      `UPDATE runs SET
         state = 'failed', failed_at_ms = ${NOW}, failure_reason = ?,
         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'`,
      [failureJson, runId, queue, claimToken],
    )
    const failedRun = fenced('runs', BY_RUN, b.fence('fail'))
    const taskOfFailedRun = `(SELECT f.task_id FROM runs f
                              WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('fail')})`
    if (retry && successorId) {
      // Only a LIVE task with user budget remaining gets a retry run. The cap
      // is expressed with the SAME user-ordinal definition the counter uses
      // (`run.attempt - infra_retries`) rather than `attempts + 1`: two
      // spellings of one quantity is how a stored counter that has drifted
      // one ahead — from the historical blind-increment bug — refuses the
      // last configured attempt while the accounting band still calls the
      // state legal. The delay runs from the failure's own instant.
      b.followOn(
        'successor',
        'runs',
        `INSERT INTO runs
           (run_id, queue, task_id, attempt, state, available_at_ms,
            wake_event, event_payload, wake_step, run_db, created_at_ms, ${FENCE_COLS})
         SELECT ?, f.queue, f.task_id, f.attempt + 1,
                CASE WHEN ? <= 0 THEN 'pending' ELSE 'sleeping' END,
                f.fence_at_ms + ?,
                f.wake_event, f.event_payload, f.wake_step, f.run_db, f.fence_at_ms,
                ${STAMP}, f.fence_at_ms
         FROM runs f JOIN tasks t ON t.task_id = f.task_id
         WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('fail')}
           AND t.state IN ${LIVE} AND (f.attempt - t.infra_retries) < t.max_attempts
           AND NOT ${successor.mine('?', 'f.task_id')}`,
        [successorId, retryDelayMs, retryDelayMs, runId, successorId],
        'one',
      )
      const successorWritten = fenced('runs', BY_RUN, b.fence('successor'))
      // attempts DERIVES from the failing run's own ordinal (the documented
      // user ordinal: run.attempt counts every successor, infra_retries the
      // infrastructure ones), so applying this twice equals applying it
      // once — an exact replay cannot double-count.
      b.followOn(
        'task-retrying',
        'tasks',
        `UPDATE tasks SET
           attempts = ${USER_ATTEMPTS_FROM('?', b.fence('fail'))},
           state = (SELECT f.state FROM runs f
                    WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('successor')}),
           last_attempt_run = ?,
           ${fenceFrom('runs', BY_RUN, b.fence('successor'))}
         WHERE task_id = ${taskOfFailedRun}
           AND state IN ${LIVE}
           AND ${successorWritten}`,
        [runId, successorId, successorId, successorId, runId, successorId],
        'one',
      )
      // Cap refused (or task no longer live): terminal, same as no-retry.
      b.followOn(
        'task-terminal',
        'tasks',
        `UPDATE tasks SET
           attempts = ${USER_ATTEMPTS_FROM('?', b.fence('fail'))},
           state = 'failed', failure_reason = ?,
           ${fenceFrom('runs', BY_RUN, b.fence('fail'))}
         WHERE task_id = ${taskOfFailedRun}
           AND state IN ${LIVE}
           AND NOT ${successor.exists('?', 'tasks.task_id', '?')}`,
        [runId, failureJson, runId, runId, successorId, runId],
        'one',
      )
    } else {
      b.followOn(
        'task',
        'tasks',
        `UPDATE tasks SET
           attempts = ${USER_ATTEMPTS_FROM('?', b.fence('fail'))},
           state = 'failed', failure_reason = ?,
           ${fenceFrom('runs', BY_RUN, b.fence('fail'))}
         WHERE task_id = ${taskOfFailedRun}
           AND state IN ${LIVE}`,
        [runId, failureJson, runId, runId],
        'one',
      )
    }
    b.followOn(
      'waits-gone',
      `DELETE FROM waits WHERE run_id = ? AND ${failedRun}`,
      [runId, runId],
      { many: 'a run may hold several waits' },
    )
    const { won } = await b.run(this.db)
    if (won !== 'fail') throw new LeaseLostError(`fail ${runId}`)
  }

  async getCheckpoints(queue: string, taskId: string, attempt: number): Promise<Checkpoint[]> {
    const [rows] = await this.db.batch(
      'get-checkpoints',
      [
        {
          sql: `SELECT checkpoint_name, state, owner_run_id, owner_attempt
                FROM checkpoints
                WHERE task_id = ? AND queue = ? AND status = 'committed'
                  AND owner_attempt <= ?
                ORDER BY checkpoint_name`,
          args: [taskId, queue, attempt],
        },
      ],
      'read',
    )
    return (rows?.rows ?? []).map((row) => ({
      checkpointName: String(row.checkpoint_name),
      stateJson: String(row.state),
      ownerRunId: String(row.owner_run_id),
      ownerAttempt: Number(row.owner_attempt),
    }))
  }

  /**
   * Lease-fenced checkpoint upsert (§3.4 rule 5). The claim token IS the
   * batch stamp here — minted at claim, unique to this worker — because the
   * lease must survive the write (the worker continues). Statement 2 keys on
   * the token fence; the attempt guard is the LWW tiebreaker, never the
   * fence. Throws LeaseLostError when the lease is gone (AB002).
   */
  async setCheckpoint(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    checkpointName: string,
    stateJson: string,
    extendLeaseSeconds: number,
  ): Promise<void> {
    const extendMs = durationToMs('extendLeaseSeconds', extendLeaseSeconds, { positive: true })
    const [extended] = await this.db.batch('set-checkpoint', [
      {
        sql: `UPDATE runs SET
                claim_expires_at_ms = ${NOW_MS} + ?, heartbeat_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND task_id = ? AND claimed_by = ?
                AND state = 'running'
                AND EXISTS (SELECT 1 FROM tasks t
                            WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})`,
        args: [extendMs, runId, queue, taskId, claimToken],
      },
      {
        sql: `INSERT INTO checkpoints
                (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
              SELECT ?, ?, ?, ?, r.run_id, r.attempt, ${NOW_MS}
              FROM runs r
              WHERE r.run_id = ? AND r.task_id = ? AND r.queue = ? AND r.claimed_by = ?
                AND r.state = 'running'
                AND EXISTS (SELECT 1 FROM tasks t2
                            WHERE t2.task_id = r.task_id AND t2.state IN ${LIVE})
              ON CONFLICT (task_id, checkpoint_name) DO UPDATE SET
                state = excluded.state,
                owner_run_id = excluded.owner_run_id,
                owner_attempt = excluded.owner_attempt,
                updated_at_ms = excluded.updated_at_ms
              WHERE excluded.owner_attempt >= checkpoints.owner_attempt`,
        args: [taskId, checkpointName, queue, stateJson, runId, taskId, queue, claimToken],
      },
    ])
    if ((extended?.rowsAffected ?? 0) !== 1) throw new LeaseLostError(`setCheckpoint ${runId}`)
  }

  async getTaskResult(queue: string, taskId: string): Promise<TaskResult | null> {
    const [rows] = await this.db.batch(
      'task-result',
      [
        {
          sql: `SELECT state, completed_payload, failure_reason FROM tasks
                WHERE task_id = ? AND queue = ?`,
          args: [taskId, queue],
        },
      ],
      'read',
    )
    const row = rows?.rows[0]
    if (!row) return null
    const result: TaskResult = { state: String(row.state) as TaskResult['state'] }
    if (row.completed_payload !== null) result.completedPayloadJson = String(row.completed_payload)
    if (row.failure_reason !== null) result.failureReasonJson = String(row.failure_reason)
    return result
  }

  async nextWakeAtEpochMs(queue: string): Promise<number | null> {
    const [rows] = await this.db.batch(
      'next-wake',
      [{ sql: NEXT_WAKE_SQL, args: [queue, queue, queue, queue] }],
      'read',
    )
    const value = rows?.rows[0]?.wake_ms
    return value === null || value === undefined ? null : Number(value)
  }

  // ── events (implements the TLC-verified EmitEvent / AwaitEvent actions) ─

  /**
   * First write wins (EventImmutable): a second emit changes nothing and
   * every waiter receives the STORED payload (PayloadMatchesEvent). The
   * same batch delivers to all registered waiters: their runs wake with
   * the event and its payload, their tasks mirror to pending, and the
   * wait rows flip to delivered — one atomic action, so an interleaved
   * await either sees the event row or gets woken, never neither.
   */
  async emitEvent(queue: string, eventName: string, payloadJson: string): Promise<void> {
    const b = new FencedBatch('emit-event', this.ids.token(), { now: NOW_MS })
    // First write wins on the PAYLOAD; the conflict branch re-stamps only, so
    // a re-emit changes no data yet still fences this batch's deliveries.
    // That preserves re-emit-re-delivers, which matters because a wait
    // registered in the window between two emits would otherwise never be
    // deliverable.
    b.cas(
      'event',
      'events',
      `INSERT INTO events (queue, event_name, payload, emitted_at_ms, ${FENCE_COLS})
       VALUES (?, ?, ?, ${NOW}, ${FENCE_VALS})
       ON CONFLICT (queue, event_name) DO UPDATE SET ${FENCE_SET}`,
      [queue, eventName, payloadJson],
    )
    const thisEvent = `f.queue = runs.queue AND f.event_name = ?`
    const emitted = fencedAt('events', thisEvent, b.fence('event'))
    // Waiters wake with the STORED payload, never the one this call carried:
    // on a re-emit they must agree with the event row. The waits index is the
    // access path; the event's stamp is the fence.
    //
    // `wake_event`/`wake_step` must match too. Trusting waits.run_id alone
    // meant a leftover waiting row naming a run woke that run whatever it was
    // actually doing — including a run asleep on a durable timer, which then
    // resumed however long early its timer had left. The wait row that proved
    // the mismatch was deleted in the same batch, so nothing afterwards looked
    // wrong. A run parked by awaitEvent carries the event and step it parked
    // on; a timer sleep carries neither.
    b.followOn(
      'wake-runs',
      'runs',
      `UPDATE runs SET
         state = 'pending',
         available_at_ms = ${emitted},
         wake_event = ?,
         event_payload = (SELECT f.payload FROM events f
                          WHERE ${thisEvent} AND f.fence_stamp = ${b.fence('event')}),
         fence_stamp = ${STAMP}, fence_at_ms = ${emitted}
       WHERE state = 'sleeping'
         AND wake_event = ?
         AND run_id IN (SELECT w.run_id FROM waits w
                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting'
                          AND w.run_id = runs.run_id AND w.step_name = runs.wake_step)
         AND ${fenced('events', thisEvent, b.fence('event'))}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})`,
      [eventName, eventName, eventName, eventName, eventName, queue, eventName, eventName],
      { many: 'an emit wakes every registered waiter' },
    )
    // Driven by the runs this batch actually woke, and never by waits.task_id.
    // Reading the task id straight off the wait row meant a corrupt wait —
    // one belonging to run A but naming healthy task B — flipped B to pending
    // while B's own run kept running: corrupt state amplified into a task
    // that was never waiting at all.
    b.followOn(
      'wake-tasks',
      'tasks',
      `UPDATE tasks SET state = 'pending',
         fence_stamp = ${STAMP},
         fence_at_ms = ${fencedAt('events', `f.queue = tasks.queue AND f.event_name = ?`, b.fence('event'))}
       WHERE state IN ${LIVE}
         AND task_id IN (SELECT r.task_id FROM waits w JOIN runs r ON r.run_id = w.run_id
                         WHERE w.queue = ? AND w.event_name = ?
                           AND r.fence_stamp = ${b.fence('wake-runs')})`,
      [eventName, queue, eventName],
      { many: 'one task per woken run' },
    )
    // DELETE, not a status flip: the wake fields on the run carry the
    // delivery, and retained rows would leak forever (cancel deletes waits
    // the same way).
    b.followOn(
      'waits-gone',
      `DELETE FROM waits WHERE queue = ? AND event_name = ? AND status = 'waiting'
         AND ${fenced('events', `f.queue = waits.queue AND f.event_name = waits.event_name`, b.fence('event'))}`,
      [queue, eventName],
      { many: 'every waiter for a fired event' },
    )
    await b.run(this.db)
  }

  /**
   * Checkpoint-or-register in ONE batch (§3.4 rule 2): if the event is
   * already emitted, nothing suspends and the stored payload returns; if
   * not, the wait registers and the run parks — the single writer
   * serializes this against emit, so the wakeup cannot be lost between
   * the check and the park. A timed wait also sets available_at: the
   * claim path already delivers the timeout wake (event set, payload
   * NULL) and deletes the expired wait row.
   */
  async awaitEvent(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    eventName: string,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false }> {
    const timeoutMs =
      timeoutSeconds === null
        ? null
        : durationToMs('timeoutSeconds', timeoutSeconds, { positive: true })
    const b = new FencedBatch('await-event', this.ids.token(), { now: NOW_MS })
    // Wait registration FIRST, fenced on the LIVE claim token + running + task
    // eligible: a stale invocation whose token was consumed matches zero and
    // writes nothing, so a run left sleeping under the same wake_step (e.g. by
    // a preserve reschedule) cannot have a wait recreated on it. The single
    // eligibility decision — including the cancellation deadline, which is
    // database time — and the timeout deadline are computed exactly once here.
    //
    // ON CONFLICT DO NOTHING means a wait already at this (run, step) makes
    // this lose, and losing is now the whole answer: the park below keys on
    // the wait THIS statement inserted. It used to key on "some waiting wait
    // for this event exists", so a stale untimed wait left by an earlier
    // attempt was borrowed along with ITS null timeout, and a fresh
    // 30-second await parked the run forever.
    b.cas(
      'register',
      'waits',
      `INSERT INTO waits
         (run_id, step_name, queue, task_id, event_name, status, timeout_at_ms,
          created_at_ms, ${FENCE_COLS})
       SELECT ?, ?, ?, ?, ?, 'waiting',
         CASE WHEN ? IS NOT NULL THEN ${NOW} + ? ELSE NULL END, ${NOW}, ${FENCE_VALS}
       WHERE NOT EXISTS (SELECT 1 FROM events WHERE queue = ? AND event_name = ?)
         AND EXISTS (SELECT 1 FROM runs r
                     WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?
                       AND r.claimed_by = ? AND r.state = 'running')
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.task_id = ? AND ${eligibleTask('t', NOW)})
       ON CONFLICT (run_id, step_name) DO NOTHING`,
      [
        runId,
        stepName,
        queue,
        taskId,
        eventName,
        timeoutMs,
        timeoutMs,
        queue,
        eventName,
        runId,
        queue,
        taskId,
        claimToken,
        taskId,
      ],
    )
    // available_at_ms IS this wait's own timeout_at_ms — copied from the row
    // just inserted, so the two can never drift and the park physically
    // cannot name the clock. claimed_by becomes NULL because a parked run
    // holds no lease; it used to receive a second, hand-rolled stamp, which
    // was this primitive reimplemented by hand.
    const thisWait = `f.run_id = ? AND f.step_name = ?`
    b.followOn(
      'park',
      'runs',
      `UPDATE runs SET
         state = 'sleeping',
         available_at_ms = (SELECT f.timeout_at_ms FROM waits f
                            WHERE ${thisWait} AND f.fence_stamp = ${b.fence('register')}),
         wake_event = ?, event_payload = NULL, wake_step = ?,
         claimed_by = NULL, claim_expires_at_ms = NULL, heartbeat_at_ms = NULL,
         ${fenceFrom('waits', thisWait, b.fence('register'))}
       WHERE run_id = ? AND queue = ? AND task_id = ? AND claimed_by = ?
         AND state = 'running'
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})
         AND ${fenced('waits', `${thisWait} AND f.status = 'waiting'`, b.fence('register'))}`,
      [
        runId,
        stepName,
        eventName,
        stepName,
        runId,
        stepName,
        runId,
        queue,
        taskId,
        claimToken,
        runId,
        stepName,
      ],
      'one',
    )
    b.followOn(
      'task-mirror',
      'tasks',
      `UPDATE tasks SET state = 'sleeping', ${fenceFrom('runs', BY_RUN, b.fence('park'))}
       WHERE task_id = ? AND state IN ${LIVE}
         AND ${fenced('runs', `${BY_RUN} AND f.state = 'sleeping'`, b.fence('park'))}`,
      [runId, taskId, runId],
      'one',
    )
    // The event row belongs to whichever batch emitted it, so this read is
    // fenced on the LIVE claim token instead: a zombie falls through to the
    // register discriminator and gets the lease error, never a success signal.
    b.openTail(
      'hit',
      'the event was written by the emitting batch, not this one; the live claim token is the fence here',
      `SELECT payload FROM events
       WHERE queue = ? AND event_name = ?
         AND EXISTS (SELECT 1 FROM runs r
                     WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?
                       AND r.claimed_by = ? AND r.state = 'running')`,
      [queue, eventName, runId, queue, taskId, claimToken],
    )
    const { won, results } = await b.run(this.db)
    const row = results.hit?.rows[0]
    if (row !== undefined) {
      return { emitted: true, payloadJson: String(row.payload) }
    }
    if (won !== 'register') {
      throw new LeaseLostError(`awaitEvent ${runId}`)
    }
    return { emitted: false }
  }
}

/** SQLite parses LIMIT -1 as unlimited (reviewed): clamp and floor. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new RangeError(`limit ${limit}`)
  return Math.max(0, Math.floor(limit))
}

function notYet(method: string): Promise<never> {
  return Promise.reject(new Error(`LibsqlSchedulerStore.${method}: not implemented yet`))
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
    leaseSeconds: Number(row.lease_ms) / 1000,
    paramsJson: String(row.params),
    retryStrategy: JSON.parse(String(row.retry_strategy)) as RetryStrategy,
    maxAttempts: Number(row.max_attempts),
    headers:
      row.headers === null ? {} : (JSON.parse(String(row.headers)) as Record<string, string>),
  }
  if (row.wake_event !== null && row.wake_step !== null) {
    // A wake sets wake_event and wake_step together (park) and clears them
    // together, so a set wake_event always has its wake_step — the SDK
    // matches on the step key. A row with wake_event set but wake_step NULL
    // cannot occur in this version (events were introduced with wake_step),
    // and is ignored rather than mis-bound to a fabricated step.
    const event = String(row.wake_event)
    const step = String(row.wake_step)
    claimed.wake =
      row.event_payload === null
        ? { event, step, timedOut: true }
        : { event, step, payloadJson: String(row.event_payload) }
  }
  return claimed
}

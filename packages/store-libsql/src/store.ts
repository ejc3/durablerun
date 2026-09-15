import {
  type Buggify,
  type Checkpoint,
  type CheckpointWrite,
  type ClaimedRun,
  DERIVED_INTEGER_BOUNDS,
  FENCE_COLS,
  FENCE_SET,
  FENCE_VALS,
  FencedBatch,
  INFRA_BACKOFF_SECONDS,
  type IdSource,
  type LeaseState,
  MAX_DURATION_MS,
  NOW,
  PERSISTED_INTEGER_BOUNDS,
  POSITIVE_CLAIM_GENERATION_BOUNDS,
  type PersistedIntegerBounds,
  type PersistedIntegerBoundsExceptClaimGeneration,
  REASON_CANCELLED,
  REASON_CLAIM_TIMEOUT,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_BACKOFF_MAX_SECONDS,
  STAMP,
  SUCCESSOR_CARRIED_COLUMNS,
  SUCCESSOR_PARENT_COLUMNS,
  type SchedulerStore,
  type SpawnOptions,
  type SpawnResult,
  type SqlExecutor,
  type SqlRow,
  type SweptRun,
  TASK_RESULT_COLUMNS,
  type TaskResult,
  type WakeSpec,
  clampLimit,
  decodeBoundedInteger,
  decodeTaskResult,
  durationToMs,
  fenceSetAt,
  mapLimit,
  neverBuggify,
  normalizeRetryStrategy,
  parseTaskValueJson,
  refusedWriteError,
  requireDerivedInteger,
  requireDurableString,
  requireEpochMs,
  requirePositiveClaimGeneration,
  requirePositiveInt,
  requireRunOrdinal,
  serializeTaskHeaders,
  serializeTaskValue,
  storageValueKind,
  successorCarriedValues,
  successorParentValues,
} from '@durablerun/core'
import {
  LIVE,
  PARKED_CLAIM,
  cancelDue,
  durableTaskHeadersAdmissible,
  durableTaskRetryAdmissible,
  eligibleTask,
  epochAdditionFits,
  fenceFrom,
  fenced,
  fencedAt,
  registeredWait,
  runAvailableDue,
  runClaimExpired,
  runClaimUnexpired,
  runOwnedByTask,
  singletonAggregate,
  soleLiveRun,
  storedCurrentRunAccounting,
  storedHighestOwnedOrdinal,
  storedIncrementableClaimGeneration,
  storedIncrementableInteger,
  storedInteger,
  storedIntegerWithin,
  storedPositiveClaimGeneration,
  successorOwned,
  taskOwnsEveryRun,
} from './fragments.js'
import { DRIVER_HEARTBEAT_INGRESS } from './schema.js'
import { NOW_MS } from './time.js'

const DEFAULT_RETRY = normalizeRetryStrategy({
  kind: 'exponential',
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 3600,
})
const DEFAULT_MAX_ATTEMPTS = 5
const TASK_INTEGER_BOUNDS = PERSISTED_INTEGER_BOUNDS.tasks
const RUN_INTEGER_BOUNDS = PERSISTED_INTEGER_BOUNDS.runs
const CHECKPOINT_INTEGER_BOUNDS = PERSISTED_INTEGER_BOUNDS.checkpoints
const wakeHasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty) as (
  value: object,
  key: PropertyKey,
) => boolean

/**
 * Classify and read a wake once before constructing its SQL shape.
 *
 * Task code shares this realm and may add an inherited `inSeconds` property
 * or expose accessors with changing values. The captured own-property check
 * makes the discriminant durable, and returning the complete shape keeps both
 * suspension paths on the same snapshot.
 */
function prepareWake(
  wake: WakeSpec,
  relative: boolean,
): {
  expression: string
  expressionArgs: [mode: number, relativeMs: number, absoluteMs: number]
  fits: string
  fitArgs: [mode: number, relativeMs: number]
} {
  const value = relative
    ? (wake as { inSeconds: number }).inSeconds
    : (wake as { atEpochMs: number }).atEpochMs
  const argument = relative
    ? durationToMs('wake.inSeconds', value)
    : requireEpochMs('wake.atEpochMs', value)
  const mode = relative ? 1 : 0
  const relativeMs = relative ? argument : 0
  const absoluteMs = relative ? 0 : argument
  return {
    // A batch label is the tracing and crash-injection address, so both wake
    // variants must compile to one statement inventory and bind shape. The
    // mode is data, not TypeScript control flow: relative wakes still derive
    // their absolute instant from database time, while absolute wakes are
    // stored verbatim after requireEpochMs validates them above.
    expression: `(CASE WHEN ? = 1 THEN ${NOW_MS} + ? ELSE ? END)`,
    expressionArgs: [mode, relativeMs, absoluteMs],
    fits: `AND (CASE WHEN ? = 1 THEN ${epochAdditionFits(NOW_MS, '?')} ELSE 1 END)`,
    fitArgs: [mode, relativeMs],
  }
}

/**
 * The persisted cancellation JSON is an untyped serialization boundary.
 *
 * Activation is the one transition that consumes maxDurationSeconds. Keep its
 * complete JSON type/range check and the resulting epoch headroom in one CASE
 * so malformed JSON is refused before json_extract can abort a later
 * statement, and so the leading run CAS cannot commit before task-start learns
 * that the derived deadline is invalid.
 */
function activationDurationAdmissible(task: string, at: string): string {
  const cancellation = `${task}.cancellation`
  const path = `'$.maxDurationSeconds'`
  const seconds = `json_extract(${cancellation}, ${path})`
  const durationMs = taskMaxDurationMs(task)
  const firstStarted = `${task}.first_started_at_ms`
  return `(CASE
    WHEN ${cancellation} IS NULL THEN 1
    WHEN NOT json_valid(${cancellation}) THEN 0
    WHEN json_type(${cancellation}, ${path}) IS NULL THEN 1
    WHEN json_type(${cancellation}, ${path}) NOT IN ('integer','real') THEN 0
    WHEN (${seconds}) < 0 OR (${durationMs}) > ${MAX_DURATION_MS} THEN 0
    WHEN NOT ${epochAdditionFits(`COALESCE(${firstStarted}, ${at})`, durationMs)} THEN 0
    ELSE 1
  END = 1)`
}

function taskMaxDurationMs(task: string): string {
  return `CAST(ROUND(
    json_extract(${task}.cancellation, '$.maxDurationSeconds') * 1000
  ) AS INTEGER)`
}

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

/**
 * The last-writer-wins tiebreak on a checkpoint upsert. Wire-visible
 * semantics, so it is ONE constant: the two write sites (the inline
 * checkpoint and the suspension marker) drifting apart would mean a step's
 * state was retained by one path and discarded by the other.
 */
const CHECKPOINT_LWW = `ON CONFLICT (task_id, checkpoint_name) DO UPDATE SET
    state = excluded.state,
    owner_run_id = excluded.owner_run_id,
    owner_attempt = excluded.owner_attempt,
    updated_at_ms = excluded.updated_at_ms
  WHERE excluded.owner_attempt >= checkpoints.owner_attempt`

/*
 * The equality makes the two attempt values one semantic ordinal. Validate
 * the checkpoint's canonical representation and range once; any different
 * owner representation fails equality. A second bounds/type predicate would
 * be redundant and no single-condition mutation could exercise it.
 */
const checkpointOwnerMatches = (checkpoint: string, owner: string): string =>
  `${storedIntegerWithin(CHECKPOINT_INTEGER_BOUNDS.owner_attempt, checkpoint)}
   AND ${owner}.run_id = ${checkpoint}.owner_run_id
   AND ${owner}.task_id = ${checkpoint}.task_id
   AND ${owner}.queue = ${checkpoint}.queue
   AND ${owner}.attempt = ${checkpoint}.owner_attempt`

/**
 * Validate the existing row whose primary key the checkpoint upsert consumes.
 *
 * This does not compare its ordinal with the incoming writer — CHECKPOINT_LWW
 * remains the tiebreaker. It only refuses malformed ownership before the
 * leading CAS can extend a lease or park a run.
 */
const validCheckpointConflict = (run: string, checkpointName: string): string =>
  `NOT EXISTS (
    SELECT 1 FROM checkpoints c
    WHERE c.task_id = ${run}.task_id
      AND c.checkpoint_name = ${checkpointName}
      AND NOT (
        c.queue = ${run}.queue
        AND EXISTS (
          SELECT 1 FROM runs owner
          WHERE ${checkpointOwnerMatches('c', 'owner')}
        )
      )
  )`

/**
 * The task follows its run's suspension state. `reschedule` and `suspendRun`
 * had this written out identically -- the same statement, the same args, in
 * two places -- which is the shape that drifts. Their eligibility guards had
 * already drifted once.
 */
function taskMirrorsRun(b: FencedBatch, runId: string, after: string): void {
  b.derived('task-mirror', {
    relation: 'runs-to-tasks',
    fence: after,
    where: 'f.run_id = ?',
    whereArgs: [runId],
    set: {
      state: `(SELECT f.state FROM runs f
               WHERE f.run_id = ? AND f.fence_stamp = ${b.fence(after)})`,
    },
    setArgs: [runId],
    narrow: `state IN ${LIVE}`,
    rows: 'one',
  })
}

/**
 * A run's waits die with the run. Four transitions end a run — the relaunch
 * cap, the claim timeout, completion and failure — and each wrote this
 * statement out. They differed only in which compare-and-set they follow,
 * which is exactly the part that must not be copied by hand.
 */
function waitsGone(b: FencedBatch, runId: string, after: string): void {
  b.derived('waits-gone', {
    relation: 'runs-to-waits',
    fence: after,
    where: 'f.run_id = ?',
    whereArgs: [runId],
    rows: 'source-keys',
  })
}

/**
 * The two suspension APIs share one post-transition shape. Keeping the task
 * mirror and wait reaping inseparable prevents a timer/deferral path from
 * clearing the run's wake fields while leaving an older registration alive.
 */
function finishSuspension(b: FencedBatch, runId: string): void {
  taskMirrorsRun(b, runId, 'suspend')
  waitsGone(b, runId, 'suspend')
}

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
          WHERE ${runOwnedByTask('r', 't')} AND r.state IN ${LIVE}
          ORDER BY r.attempt DESC LIMIT 1) AS run_id
FROM tasks t
WHERE t.queue = ? AND ${cancelDue('t', NOW_MS)}
  AND t.state IN ${LIVE}
  AND ${taskOwnsEveryRun('t')}
ORDER BY t.cancel_at_ms, t.task_id
LIMIT ?`

export const NEXT_WAKE_SQL = `SELECT MIN(v) AS wake_ms FROM (
  SELECT MIN(r.available_at_ms) AS v FROM runs r
    WHERE r.queue = ? AND r.state = 'pending'
      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, 'r')}
  UNION ALL
  SELECT MIN(r.available_at_ms) FROM runs r
    WHERE r.queue = ? AND r.state = 'sleeping'
      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, 'r')}
  UNION ALL
  SELECT MIN(r.claim_expires_at_ms) FROM runs r
    WHERE r.queue = ? AND r.state = 'running'
      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.claim_expires_at_ms, 'r')}
  UNION ALL
  SELECT MIN(t.cancel_at_ms) FROM tasks t
    WHERE t.queue = ? AND t.state IN ${LIVE}
      AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.cancel_at_ms, 't')}
)`

const storedSweepGenerations = (run: string): string =>
  `${storedPositiveClaimGeneration(run)}
   AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, run)}`

const storedSweepCounters = (run: string): string =>
  `${storedSweepGenerations(run)}
   AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}`

/**
 * A live owner may either reopen a lost launch or fail an activated timeout.
 * This same property gates discovery before LIMIT and both winning CASes.
 */
const sweepLiveOwnerAdmissible = (run: string, task: string): string =>
  `${storedSweepCounters(run)}
   AND ${soleLiveRun(run)}
   AND ${storedCurrentRunAccounting(run, task)}
   AND ${storedHighestOwnedOrdinal(run)}
   AND (${run}.activated_gen < ${run}.claim_gen
     OR (${run}.activated_gen = ${run}.claim_gen
       AND (${task}.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}
         OR (${storedIncrementableInteger(RUN_INTEGER_BOUNDS.attempt, run)}
           AND ${run}.attempt = ${task}.attempts + ${task}.infra_retries + 1))))`

/**
 * Terminal owners are inert, but an already terminalizing sweep arm may still
 * quiesce their running row (DESIGN §3.4 rule 6). A lost launch below the cap
 * is deliberately excluded because its only live-owner action would revive.
 */
const sweepTerminalOwnerAdmissible = (run: string): string =>
  `${storedSweepGenerations(run)}
   AND (${run}.activated_gen = ${run}.claim_gen
     OR (${run}.activated_gen < ${run}.claim_gen
       AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}
       AND ${run}.relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}))`

const sweepScanAdmissible = (run: string, task: string): string =>
  `((${task}.state IN ${LIVE} AND ${sweepLiveOwnerAdmissible(run, task)})
    OR (${task}.state NOT IN ${LIVE} AND ${sweepTerminalOwnerAdmissible(run)}))`

export const SWEEP_SCAN_EXPIRED_SQL = `SELECT r.run_id, r.task_id, r.claim_gen, r.activated_gen, r.relaunch_count
FROM runs r JOIN tasks t ON ${runOwnedByTask('r', 't')}
WHERE r.queue = ? AND r.state = 'running'
  AND ${runClaimExpired('r', NOW_MS)}
  AND ${sweepScanAdmissible('r', 't')}
ORDER BY r.claim_expires_at_ms, r.run_id
LIMIT ?`

/**
 * The sweep runs its per-item batches at most this many at once through core
 * `mapLimit`. The fencing discipline requires per-item atomicity, never
 * sequential issuance.
 */
const SWEEP_PIPELINE_WIDTH = 8

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

  private serializeHeaders(headersInput: unknown): string | null {
    const serializeTaskValue = serializeTaskHeaders
    const headersJson =
      headersInput === undefined ? null : serializeTaskValue('task headers', headersInput)
    return headersJson
  }

  async spawn(
    queue: string,
    taskName: string,
    paramsJson: string,
    opts: SpawnOptions = {},
  ): Promise<SpawnResult> {
    const durableTaskName = requireDurableString('taskName', taskName)
    const idempotencyKeyInput = opts.idempotencyKey
    const key =
      idempotencyKeyInput === undefined
        ? null
        : requireDurableString('idempotencyKey', idempotencyKeyInput)
    const taskId = this.ids.uuidv7()
    const runId = this.ids.uuidv7()
    const retryInput = opts.retryStrategy
    const retry = serializeTaskValue(
      'retry strategy',
      normalizeRetryStrategy(retryInput === undefined ? DEFAULT_RETRY : retryInput),
    )
    const maxAttempts = requirePositiveInt('maxAttempts', opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    const delayMs = durationToMs('startDelaySeconds', opts.startDelaySeconds ?? 0)
    const cancellationInput = opts.cancellation
    let cancellationJson: string | null = null
    let maxDelayMs: number | null = null
    if (cancellationInput !== undefined) {
      const maxDelaySeconds = cancellationInput.maxDelaySeconds
      const maxDurationSeconds = cancellationInput.maxDurationSeconds
      if (maxDelaySeconds !== undefined) {
        maxDelayMs = durationToMs('cancellation.maxDelaySeconds', maxDelaySeconds)
      }
      // maxDurationSeconds is applied at activate. Canonicalize it from the
      // same one-time snapshot that was validated, so a getter cannot make
      // the durable JSON disagree with the deadline arithmetic.
      const canonicalCancellation = {
        maxDelaySeconds: maxDelayMs === null ? undefined : maxDelayMs / 1000,
        maxDurationSeconds:
          maxDurationSeconds === undefined
            ? undefined
            : durationToMs('cancellation.maxDurationSeconds', maxDurationSeconds) / 1000,
      }
      cancellationJson = serializeTaskValue('cancellation policy', canonicalCancellation)
    }

    const headersInput = opts.headers
    const headersJson = this.serializeHeaders(headersInput)
    const b = new FencedBatch('spawn', this.ids.token(), { now: NOW_MS })
    // Idempotent task insert: loses silently when the key already exists.
    // enqueue/cancel deadlines are computed in SQL (rule 3); cancel_at_ms
    // materializes max_delay so sweeps and nextWakeAt are indexed reads, never
    // JSON scans. A task without max_delay binds NULL, and NULL propagates
    // through the addition, so its cancel_at_ms is NULL.
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
         ${NOW} + ? + ?,
         ${NOW}, ${FENCE_VALS}
       WHERE NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ?)
         AND ${epochAdditionFits(NOW, '?')}
         AND (? IS NULL OR ${epochAdditionFits(NOW, '?', '?')})
       ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [
        taskId,
        queue,
        durableTaskName,
        paramsJson,
        headersJson,
        retry,
        maxAttempts,
        cancellationJson,
        key,
        delayMs,
        delayMs,
        maxDelayMs,
        taskId,
        taskId,
        delayMs,
        maxDelayMs,
        delayMs,
        maxDelayMs,
      ],
    )
    // The initial run, for the task THIS batch just created. One guard the
    // old version needed has deleted itself: the task cannot be terminal, we
    // inserted it 'pending' one statement ago.
    //
    // The "no run yet" guard stays, in ownership form, because the task's
    // STAMP does not distinguish this execution from the previous one. On an
    // exact replay after a lost response the task insert correctly writes
    // nothing — the task is already there — but the task still CARRIES the
    // first pass's stamp, so this statement matched and inserted the same run
    // again, dying on the run's primary key. The caller then saw an error for
    // a spawn that had fully succeeded, and a retry without an idempotency
    // key made duplicate work. Asking whether the task already has a run is a
    // question about ownership, which does not decay.
    b.followOn(
      'run',
      'runs',
      `INSERT INTO runs (run_id, queue, task_id, attempt, state,
         available_at_ms, created_at_ms, ${FENCE_COLS})
       SELECT ?, f.queue, f.task_id, 1, 'pending', f.enqueue_at_ms, f.fence_at_ms,
         ${STAMP}, f.fence_at_ms
       FROM tasks f WHERE f.task_id = ? AND f.fence_stamp = ${b.fence('task')}
         AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.enqueue_at_ms, 'f')}
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = f.task_id)`,
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
      `SELECT winner.task_id AS task_id,
              (SELECT r.run_id FROM runs r
                 WHERE ${runOwnedByTask('r', 'winner')}
                 ORDER BY r.attempt DESC LIMIT 1) AS run_id
       FROM (
         SELECT t.task_id, t.queue, 1 AS priority
         FROM tasks t WHERE t.task_id = ? AND t.queue = ?
         UNION ALL
         SELECT t.task_id, t.queue, 0 AS priority
         FROM tasks t
         WHERE ? IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?
           AND t.task_id <> ?
       ) winner
       ORDER BY winner.priority, winner.task_id
       LIMIT 1`,
      [taskId, queue, key, queue, key, taskId],
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
    const limit = requirePositiveInt('limit', opts.limit)
    // Buggify: a short claim is always legal (limit is a maximum) — ticks
    // must drain via the successor-tick chain, never assume a full batch.
    const effectiveLimit = limit > 1 && this.buggify('claim:short-batch') ? 1 : limit
    const claimedWait = registeredWait('runs')
    // Eligibility belongs inside each ordered leg, BEFORE its limit. Filtering
    // the merged shortlist lets an earlier corrupt/ineligible run consume the
    // whole budget and permanently starve later healthy work.
    const claimEligibility = (run: string, task: string): string => {
      const wait = registeredWait(run)
      return `${eligibleTask(task, NOW)}
               AND ${durableTaskRetryAdmissible(task)}
               AND ${durableTaskHeadersAdmissible(task)}
               AND ${soleLiveRun(run)}
               AND (${run}.wake_step IS NOT NULL OR ${wait.unambiguous})
               AND ${wait.temporallySafe}
               AND ${storedIncrementableClaimGeneration(run)}
               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, run)}
               AND ${run}.activated_gen <= ${run}.claim_gen
               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}
               AND ${storedCurrentRunAccounting(run, task)}
               AND ${storedHighestOwnedOrdinal(run)}`
    }
    const candidateEligibility = claimEligibility('r', 't')
    const b = new FencedBatch('claim', this.ids.token(), { now: NOW_MS })
    // Due runs of live tasks → running, holding the caller's lease token AND
    // this batch's provenance. The two are now different things, which is the
    // point: the token survives the batch by contract (the worker keeps
    // working), so it cannot tell one delivery of a claim from another. The
    // candidate subselect remains a bounded per-state UNION: after eligibility
    // each leg is an ordered index scan of at most K rows rather than a temp
    // b-tree over the backlog, a shape the query-plan suite pins. The generation
    // bump is safe here because the CAS's own guard consumes the pre-state.
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
         wake_step = COALESCE(wake_step, ${claimedWait.step}),
         ${FENCE_SET}
       WHERE run_id IN (
         SELECT c.run_id FROM (
           SELECT * FROM (
             SELECT r.run_id, r.available_at_ms FROM runs r
             JOIN tasks t ON ${runOwnedByTask('r', 't')}
             WHERE r.queue = ? AND r.state = 'pending'
               AND ${runAvailableDue('r', NOW)}
               AND ${candidateEligibility}
             ORDER BY r.available_at_ms, r.run_id LIMIT ?
           )
           UNION ALL
           SELECT * FROM (
             SELECT r.run_id, r.available_at_ms FROM runs r
             JOIN tasks t ON ${runOwnedByTask('r', 't')}
             WHERE r.queue = ? AND r.state = 'sleeping'
               AND ${runAvailableDue('r', NOW)}
               AND ${candidateEligibility}
             ORDER BY r.available_at_ms, r.run_id LIMIT ?
           )
         ) c
         ORDER BY c.available_at_ms, c.run_id
         LIMIT ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM runs held
         WHERE held.queue = ? AND held.state = 'running' AND held.claimed_by = ?
       )
       AND ${epochAdditionFits(NOW, '?')}`,
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
        leaseMs,
      ],
    )
    // attempts is deliberately NOT touched: per the accounting model it moves
    // only on user-failure transitions, never at claim.
    b.derived('task-book', {
      relation: 'runs-to-tasks',
      fence: 'claim',
      where: `f.queue = ? AND f.state = 'running'`,
      whereArgs: [queue],
      set: {
        state: `'running'`,
        // The eligibility guard makes this exactly one. Keep the expression
        // scalar even under a guard regression so every dialect exposes that
        // regression as the same poisoned-state change instead of SQLite
        // choosing a row while PostgreSQL/MySQL abort the batch.
        last_attempt_run: singletonAggregate(
          'f.run_id',
          'runs f',
          `f.task_id = tasks.task_id AND f.fence_stamp = ${b.fence('claim')}`,
          'f.task_id',
        ).value,
      },
      narrow: `state IN ${LIVE}`,
      rows: 'source-keys',
    })
    // A timed-out waiter's claim consumes its wait row, so a later emit cannot
    // resurrect a timed-out wait (§3.4 rule 2, timeout branch). Both halves
    // changed. It used to select rows by the caller's token, which a DUPLICATE
    // delivery of the same claim also matches even though its own CAS
    // correctly took nothing — and it then compared their deadlines against a
    // FRESH clock read, so waits that fell due between the two deliveries were
    // deleted by the delivery that had claimed nothing. Now it sees only rows
    // this batch stamped, and compares against the instant that batch
    // recorded.
    b.derived('waits-timeout', {
      relation: 'runs-to-waits',
      fence: 'claim',
      where: `f.queue = ? AND f.state = 'running'`,
      whereArgs: [queue],
      narrow: `status = 'waiting'
            AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.waits.timeout_at_ms)}
            AND timeout_at_ms <= ${fencedAt('runs', `f.run_id = waits.run_id`, b.fence('claim'))}`,
      rows: 'source-keys',
    })
    // Deliberately keyed on the LEASE token, not this batch's stamp: §3.4
    // rule 4 makes a same-token claim an idempotent receipt that returns the
    // ORIGINAL selection, so this read must see rows a PREVIOUS batch stamped.
    // Only LIVE tasks, so a terminal task's corrupt running run is never
    // launched.
    b.openTail(
      'picked',
      'rule 4: a same-token retry is a receipt and must return the original selection, which a previous batch stamped',
      `SELECT ${CLAIMED_RUN_COLUMNS}
       FROM runs r JOIN tasks t ON ${runOwnedByTask('r', 't')}
       WHERE r.queue = ? AND r.claimed_by = ? AND r.state = 'running'
         AND t.state IN ${LIVE}
         AND ${durableTaskRetryAdmissible('t')}
         AND ${durableTaskHeadersAdmissible('t')}
         AND ${soleLiveRun('r')}
         AND ${storedPositiveClaimGeneration('r')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, 'r')}
         AND r.activated_gen <= r.claim_gen
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'r')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'r')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.claim_expires_at_ms, 'r')}
         AND ${storedCurrentRunAccounting('r', 't')}
         AND ${storedHighestOwnedOrdinal('r')}
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
    const validClaimGen = requirePositiveClaimGeneration('activate.claimGen', claimGen)
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
         AND ${storedPositiveClaimGeneration('runs')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, 'runs')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'runs')}
         AND ${epochAdditionFits(NOW, 'runs.lease_ms')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'runs')}
         AND ${soleLiveRun('runs')}
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)}
             AND ${durableTaskRetryAdmissible('t')}
             AND ${durableTaskHeadersAdmissible('t')}
             AND ${storedCurrentRunAccounting('runs', 't')}
             AND ${storedHighestOwnedOrdinal('runs')}
             AND ${activationDurationAdmissible('t', NOW)}
         )`,
      [validClaimGen, runId, queue, claimToken, validClaimGen, validClaimGen],
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
    b.derived('task-start', {
      relation: 'runs-to-tasks',
      fence: 'activate',
      where: 'f.run_id = ?',
      whereArgs: [runId],
      set: {
        first_started_at_ms: `COALESCE(first_started_at_ms, ${activated})`,
        // The leading CAS validated both this stored JSON value and the exact
        // headroom of the addition. Keep conversion in one shared expression
        // so the guard and write cannot disagree below a millisecond.
        cancel_at_ms: `CASE
          WHEN json_type(cancellation, '$.maxDurationSeconds') IS NOT NULL THEN
            COALESCE(first_started_at_ms, ${activated}) + ${taskMaxDurationMs('tasks')}
          ELSE NULL
        END`,
      },
      setArgs: [runId, runId],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    // Full payload for the winning worker. Fenced, so it can only return the
    // row THIS delivery activated — the post-state alone cannot tell "I won"
    // from "a previous delivery of the same claim won", since both leave
    // activated_gen equal to claim_gen.
    b.tail(
      'payload',
      `SELECT ${CLAIMED_RUN_COLUMNS}
       FROM runs r JOIN tasks t ON ${runOwnedByTask('r', 't')}
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
    extendLeaseSeconds: number,
  ): Promise<LeaseState> {
    // Buggify: lease-lost can arrive at ANY heartbeat — workers must abort
    // cleanly on the AB002 signal no matter when it fires.
    if (this.buggify('heartbeat:lease-lost')) return { held: false, remainingMs: 0 }
    const extendMs = durationToMs('extendLeaseSeconds', extendLeaseSeconds, { positive: true })
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
                            WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})
                AND ${epochAdditionFits(NOW_MS, '?')}
              RETURNING claim_expires_at_ms - heartbeat_at_ms AS remaining_ms`,
        args: [extendMs, runId, queue, claimToken, extendMs],
      },
    ])
    const row = extended?.rows[0]
    if (!row) return { held: false, remainingMs: 0 }
    return {
      held: true,
      remainingMs: requireDerivedInteger(
        'heartbeat.remaining_ms',
        row.remaining_ms,
        DERIVED_INTEGER_BOUNDS.duration_ms,
      ),
    }
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
          kind: 'lost-launch'
          runId: string
          taskId: string
          claimGen: number
          relaunchCount: number
        }
      | {
          kind: 'claim-timeout'
          runId: string
          taskId: string
          claimGen: number
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
      const claimGen = persistedPositiveClaimGeneration('sweep', row)
      const activatedGen = persistedRowInteger('sweep', row, RUN_INTEGER_BOUNDS.activated_gen)
      const identity = {
        runId: String(row.run_id),
        taskId: String(row.task_id),
        claimGen,
      }
      items.push(
        activatedGen < claimGen
          ? {
              kind: 'lost-launch',
              ...identity,
              relaunchCount: persistedRowInteger('sweep', row, RUN_INTEGER_BOUNDS.relaunch_count),
            }
          : { kind: 'claim-timeout', ...identity },
      )
    }

    const outcomes = await mapLimit(
      items,
      SWEEP_PIPELINE_WIDTH,
      (item): Promise<SweptRun | null> => {
        if (item.kind === 'cancel') {
          const batch = new FencedBatch('sweep:cancel', this.ids.token(), { now: NOW_MS })
          return this.cancelTransition(batch, queue, item.taskId, true).then((won) =>
            won ? { kind: 'cancelled', taskId: item.taskId, runId: item.runId } : null,
          )
        }
        return item.kind === 'lost-launch'
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
                   AND activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}`
    const relaunchDelayMs = `MIN(
      (relaunch_count + 1) * ${RELAUNCH_BACKOFF_BASE_SECONDS},
      ${RELAUNCH_BACKOFF_MAX_SECONDS}
    ) * 1000`
    const liveOwner = `EXISTS (
      SELECT 1 FROM tasks t
      WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE}
        AND ${sweepLiveOwnerAdmissible('runs', 't')}
    )`
    const terminalOwner = `EXISTS (
      SELECT 1 FROM tasks t
      WHERE ${runOwnedByTask('runs', 't')} AND t.state NOT IN ${LIVE}
        AND ${sweepTerminalOwnerAdmissible('runs')}
    )`
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
         available_at_ms = ${NOW} + ${relaunchDelayMs},
         ${FENCE_SET}
       WHERE ${guard} AND relaunch_count < ${RUN_INTEGER_BOUNDS.relaunch_count.max}
         AND ${liveOwner}
         AND ${epochAdditionFits(NOW, relaunchDelayMs)}`,
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
       WHERE ${guard} AND relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}
         AND (${liveOwner} OR ${terminalOwner})`,
      [REASON_RELAUNCH_CAP, item.runId, queue, item.claimGen],
    )
    // The task mirrors the run (the reviewed phantom-'running' divergence
    // from the TLA SweepLostLaunch action). Each arm names the CAS it
    // follows, so neither can fire for the other's outcome.
    b.derived('task-pending', {
      relation: 'runs-to-tasks',
      fence: 'reopen',
      where: 'f.run_id = ?',
      whereArgs: [item.runId],
      set: { state: `'pending'` },
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    b.derived('task-fail', {
      relation: 'runs-to-tasks',
      fence: 'cap',
      where: 'f.run_id = ?',
      whereArgs: [item.runId],
      set: { state: `'failed'`, failure_reason: '?' },
      setArgs: [REASON_RELAUNCH_CAP],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    waitsGone(b, item.runId, 'cap')
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
    item: { runId: string; taskId: string; claimGen: number },
  ): Promise<SweptRun | null> {
    const successorId = this.ids.uuidv7()
    const infraDelayMs = `${INFRA_BACKOFF_SECONDS} * 1000`
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
         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')}
             AND ((t.state NOT IN ${LIVE}
                 AND ${sweepTerminalOwnerAdmissible('runs')})
               OR (t.state IN ${LIVE}
                 AND ${sweepLiveOwnerAdmissible('runs', 't')}
                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}
                   OR ${epochAdditionFits(NOW, infraDelayMs)})))
         )`,
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
          ${SUCCESSOR_PARENT_COLUMNS}, ${FENCE_COLS})
       SELECT ?, f.queue, f.task_id, f.attempt + 1, 'pending',
              f.fence_at_ms + ${infraDelayMs},
              ${successorParentValues('f')},
              ${STAMP}, f.fence_at_ms
       FROM runs f JOIN tasks t ON ${runOwnedByTask('f', 't')}
       WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('fail')}
         AND t.state IN ${LIVE}
         AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.infra_retries, 't')}
         AND t.infra_retries < ${TASK_INTEGER_BOUNDS.infra_retries.max}
         AND ${storedIncrementableInteger(RUN_INTEGER_BOUNDS.attempt, 'f')}
         AND NOT ${successorOwned('?', 'f.task_id', 'f.attempt + 1')}`,
      [successorId, item.runId, successorId],
      'one',
    )
    // At the cap (pre-increment): terminal. Terminal ONLY when this batch
    // actually failed to place a successor — keying on the cap alone made an
    // exact replay terminalize the task over the successor the first pass had
    // just created (rule 6).
    b.derived('task-terminal', {
      relation: 'runs-to-tasks',
      fence: 'fail',
      where: 'f.run_id = ?',
      whereArgs: [item.runId],
      set: { state: `'failed'`, failure_reason: '?' },
      setArgs: [REASON_INFRA_CAP],
      narrow: `state IN ${LIVE}
            AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.infra_retries)}
            AND infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}
            AND NOT ${successorOwned(
              '?',
              'tasks.task_id',
              `(SELECT p.attempt + 1 FROM runs p
                WHERE p.run_id = ? AND p.fence_stamp = ${b.fence('fail')})`,
            )}`,
      narrowArgs: [successorId, item.runId],
      rows: 'one',
    })
    // Bookkeeping keyed on our successor existing. The counter DERIVES from
    // the successor's own attempt ordinal rather than incrementing:
    // run.attempt counts every successor (user + infra), so infra = attempt -
    // 1 - user attempts. Applying this twice is the same as applying it once,
    // so an exact replay cannot double-count.
    b.derived('bookkeeping', {
      relation: 'runs-to-tasks',
      fence: 'successor',
      where: 'f.run_id = ?',
      whereArgs: [successorId],
      set: {
        infra_retries: INFRA_RETRIES_FROM('?', b.fence('successor')),
        state: `'pending'`,
        last_attempt_run: '?',
      },
      setArgs: [successorId, successorId],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    // The dead run's waits die with it (the reviewed orphan-waits leak).
    waitsGone(b, item.runId, 'fail')
    const { won, results } = await b.run(this.db)
    if (won !== 'fail') return null // lost the race
    // Report what the batch DID, not what it can be inferred to have done.
    // Reading "the successor insert wrote nothing" as "the cap is exhausted"
    // conflates every other reason it can write nothing — the id already
    // belongs to a run of this task, or the task stopped being live partway —
    // and reports a cap exhaustion that did not happen. Each arm names the
    // statement that actually fired; when none did, this sweep has nothing to
    // report rather than something untrue.
    if ((results.bookkeeping?.rowsAffected ?? 0) === 1) {
      return {
        kind: 'claim-timeout',
        runId: item.runId,
        taskId: item.taskId,
        successorRunId: successorId,
      }
    }
    if ((results['task-terminal']?.rowsAffected ?? 0) === 1) {
      return { kind: 'infra-cap-exhausted', runId: item.runId, taskId: item.taskId }
    }
    return null
  }

  /**
   * The single advisory write (§3.9): accelerate lease expiry, nothing more.
   * True only when it shortened a live lease. NOTE: a still-alive worker's
   * subsequent heartbeat may legitimately re-extend — the lease remains the
   * sole authority and advisory signals never revoke it.
   */
  async expireLeaseNow(queue: string, runId: string, claimToken: string): Promise<boolean> {
    const unexpired = runClaimUnexpired('runs', NOW_MS)
    const owner = runOwnedByTask('runs', 't')
    const [expired] = await this.db.batch('expire-lease-now', [
      {
        sql: `UPDATE runs SET claim_expires_at_ms = ${NOW_MS}
              WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
                AND ${unexpired}
                AND EXISTS (
                  SELECT 1 FROM tasks t
                  WHERE ${owner}
                )`,
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
        sql: `INSERT INTO ${DRIVER_HEARTBEAT_INGRESS}
                (queue, driver_id, last_beat_ms, expires_at_ms)
              SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?
              WHERE ${epochAdditionFits(NOW_MS, '?')}`,
        args: [queue, driverId, ttlMs, ttlMs],
      },
    ])
  }

  async retryTask(
    queue: string,
    taskId: string,
  ): Promise<{ runId: string; attempt: number } | null> {
    const runId = this.ids.uuidv7()
    const top = (task: string) =>
      `(SELECT MAX(r.attempt) FROM runs r WHERE ${runOwnedByTask('r', task)})`
    const noLiveRun = (task: string) =>
      `NOT EXISTS (SELECT 1 FROM runs r
                   WHERE ${runOwnedByTask('r', task)} AND r.state IN ${LIVE})`
    // Absurd's retry_task, the TLA RetryTask action. One task CAS revives a
    // failed task that owns every run and has none live. Charging the top run
    // keeps attempts + infra_retries equal to the top ordinal when the task failed
    // at the infrastructure or relaunch cap, where no counter recorded that run.
    // The charge never exceeds the budget (TLA FailedChargeWithinBudget), so the
    // budget grows by exactly one.
    const charged = `(${top('tasks')} - infra_retries)`
    const b = new FencedBatch('retry-task', this.ids.token(), { now: NOW_MS })
    // Only a well-formed failure revives. A failed row with no reason, or with a
    // completed payload, is a corrupt outcome, and clearing the reason would pass
    // that corruption on to a pending task. The same holds for the counters: each
    // must be an exact integer in range, every owned run's ordinal too, the budget
    // must take one more, and the charge must be the recorded attempts or one more
    // and within the budget.
    b.cas(
      'revive',
      'tasks',
      `UPDATE tasks SET
         state = 'pending',
         attempts = ${charged},
         max_attempts = max_attempts + 1,
         failure_reason = NULL,
         last_attempt_run = ?,
         ${FENCE_SET}
       WHERE task_id = ? AND queue = ? AND state = 'failed'
         AND failure_reason IS NOT NULL AND completed_payload IS NULL
         AND ${taskOwnsEveryRun('tasks')}
         AND EXISTS (SELECT 1 FROM runs r WHERE ${runOwnedByTask('r', 'tasks')})
         AND ${noLiveRun('tasks')}
         AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.attempts, 'tasks')}
         AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.infra_retries, 'tasks')}
         AND NOT EXISTS (SELECT 1 FROM runs r
                         WHERE ${runOwnedByTask('r', 'tasks')}
                           AND NOT ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'r')})
         AND ${storedIncrementableInteger(TASK_INTEGER_BOUNDS.max_attempts, 'tasks')}
         AND ${charged} - attempts IN (0, 1)
         AND ${charged} <= max_attempts`,
      [runId, taskId, queue],
    )
    // The revival run, keyed on the revive stamp, carries the top run's parked
    // wake as every successor does. The live-run check is ownership, so an exact
    // replay that still sees the first pass's stamp inserts nothing.
    b.followOn(
      'run',
      'runs',
      `INSERT INTO runs (run_id, queue, task_id, attempt, state,
         available_at_ms, created_at_ms, ${SUCCESSOR_CARRIED_COLUMNS}, ${FENCE_COLS})
       SELECT ?, f.queue, f.task_id, p.attempt + 1, 'pending', f.fence_at_ms, f.fence_at_ms,
         ${successorCarriedValues('p')}, ${STAMP}, f.fence_at_ms
       FROM tasks f JOIN runs p ON ${runOwnedByTask('p', 'f')}
       WHERE f.task_id = ? AND f.fence_stamp = ${b.fence('revive')} AND p.attempt = ${top('f')}
         AND ${noLiveRun('f')}`,
      [runId, taskId],
      'one',
    )
    b.tail(
      'revived',
      `SELECT attempt FROM runs WHERE run_id = ? AND fence_stamp = ${b.fence('run')}`,
      [runId],
    )
    const { won, results } = await b.run(this.db)
    if (won !== 'revive') return null
    const row = results.revived?.rows[0]
    if (!row) throw new Error(`retryTask ${taskId}: the revival won but inserted no run`)
    return { runId, attempt: Number(row.attempt) }
  }

  async cancelTask(queue: string, taskId: string): Promise<boolean> {
    const batch = new FencedBatch('cancel-task', this.ids.token(), { now: NOW_MS })
    return this.cancelTransition(batch, queue, taskId, false)
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
    b: FencedBatch,
    queue: string,
    taskId: string,
    deadlineOnly: boolean,
  ): Promise<boolean> {
    const deadlineGuard = deadlineOnly ? `AND ${cancelDue('tasks', NOW)}` : ''
    b.cas(
      'cancel',
      'tasks',
      `UPDATE tasks SET
         state = 'cancelled', cancelled_at_ms = ${NOW}, cancel_at_ms = NULL,
         failure_reason = ?, ${FENCE_SET}
       WHERE task_id = ? AND queue = ? AND state IN ${LIVE} ${deadlineGuard}
         AND ${taskOwnsEveryRun('tasks')}`,
      [REASON_CANCELLED, taskId, queue],
    )
    b.derived('runs', {
      relation: 'tasks-to-runs',
      fence: 'cancel',
      where: 'f.task_id = ?',
      whereArgs: [taskId],
      set: { state: `'cancelled'`, claimed_by: 'NULL', claim_expires_at_ms: 'NULL' },
      narrow: `state IN ${LIVE}`,
      rows: 'source-keys',
    })
    b.derived('waits', {
      // Wait ownership comes from the runs this transition actually
      // cancelled, never from waits.task_id: that denormalized mirror may be
      // corrupt, while waits.run_id is the authoritative relationship.
      relation: 'runs-to-waits',
      fence: 'runs',
      where: `f.task_id = ? AND f.state = 'cancelled'`,
      whereArgs: [taskId],
      rows: 'source-keys',
    })
    const { won } = await b.run(this.db)
    return won === 'cancel'
  }

  /**
   * Why a refused worker write lost (`refusedWriteError`). The run's state is read
   * only after a refusal, so a write that wins pays nothing for it. A cancelled
   * run is terminal, so the read never misses a cancellation that refused the
   * write.
   */
  private refusal(operation: string, runId: string): Promise<Error> {
    return refusedWriteError(operation, runId, async () => {
      const [rows] = await this.db.batch(
        'refusal-state',
        [{ sql: 'SELECT state FROM runs WHERE run_id = ?', args: [runId] }],
        'read',
      )
      return rows?.rows[0]?.state
    })
  }

  async claimedTaskName(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
  ): Promise<string | null> {
    const validClaimGen = requirePositiveClaimGeneration('claimedTaskName.claimGen', claimGen)
    // The launch carries only ids, so the worker learns the claimed task's name
    // here. The name is immutable, so an unfenced read is safe; the claim
    // conditions only make a stale or already-activated launch read nothing.
    const [rows] = await this.db.batch(
      'claimed-task-name',
      [
        {
          sql: `SELECT t.task_name FROM runs r JOIN tasks t ON ${runOwnedByTask('r', 't')}
                WHERE r.run_id = ? AND r.queue = ? AND r.claimed_by = ? AND r.state = 'running'
                  AND r.claim_gen = ? AND r.activated_gen < ?`,
          args: [runId, queue, claimToken, validClaimGen, validClaimGen],
        },
      ],
      'read',
    )
    const name = rows?.rows[0]?.task_name
    return typeof name === 'string' ? name : null
  }

  /** §3.2 rolling-deploy deferral; the port documents its contract. */
  async deferLaunch(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
    inSeconds: number,
  ): Promise<void> {
    const validClaimGen = requirePositiveClaimGeneration('deferLaunch.claimGen', claimGen)
    const wakePlan = prepareWake({ inSeconds }, true)
    // The rolling-deploy deferral, decided before activation.
    // Fencing on the claim RECEIPT, not an activation, is the point: the run
    // must still be running under this token and generation with no activation
    // yet, so the first-start latch, the start deadline, and the duration clock
    // stay untouched, and a replay after the park or after an activation
    // matches nothing. Nothing is consumed and the wake fields are kept. Like
    // every suspension it requires an eligible task, and it refuses the corrupt
    // shapes activation refuses: another live run, drifted accounting, an
    // obsolete ordinal, an out-of-range lease or relaunch counter, or an
    // inadmissible stored retry strategy or header set.
    const b = new FencedBatch('defer-launch', this.ids.token(), { now: NOW_MS })
    b.cas(
      'suspend',
      'runs',
      `UPDATE runs SET
         state = CASE WHEN ${wakePlan.expression} <= ${NOW} THEN 'pending' ELSE 'sleeping' END,
         available_at_ms = ${wakePlan.expression},
         ${PARKED_CLAIM},
         ${FENCE_SET}
       WHERE claim_gen = ? AND activated_gen < ?
         AND run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND ${storedPositiveClaimGeneration('runs')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, 'runs')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'runs')} AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'runs')}
         AND ${soleLiveRun('runs')}
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)}
             AND ${storedCurrentRunAccounting('runs', 't')}
             AND ${storedHighestOwnedOrdinal('runs')}
             AND ${durableTaskRetryAdmissible('t')}
             AND ${durableTaskHeadersAdmissible('t')}
         )
         ${wakePlan.fits}`,
      [
        ...wakePlan.expressionArgs,
        ...wakePlan.expressionArgs,
        validClaimGen,
        validClaimGen,
        runId,
        queue,
        claimToken,
        ...wakePlan.fitArgs,
      ],
    )
    finishSuspension(b, runId)
    const { won } = await b.run(this.db)
    if (won !== 'suspend') throw await this.refusal('deferLaunch', runId)
  }

  /**
   * Sleep, defer, or attempt-neutral chain (§3.2). The worker's own claim
   * token is the ownership proof; the transition mints a fresh stamp into
   * claimed_by so the suspended run carries no live token (a zombie's later
   * writes die on claimed_by). Refusals follow the port's refused-write contract.
   */
  async reschedule(
    queue: string,
    runId: string,
    claimToken: string,
    wake: WakeSpec,
  ): Promise<void> {
    const relativeWake = wakeHasOwn(wake, 'inSeconds')
    const wakePlan = prepareWake(wake, relativeWake)
    // The task must be ELIGIBLE, not merely live — the same predicate
    // suspendRun uses, which is what its comment always claimed ("reschedule's
    // exact transition plus the marker") while the two guards had quietly
    // diverged. A suspension makes the run schedulable again, and the claim
    // path already refuses to launch a task whose cancellation deadline is
    // due; letting the run re-park itself would put it straight back into the
    // queue that path is keeping it out of. Refusing surfaces AB002, so the
    // worker stops now instead of being cancelled a moment later.
    const b = new FencedBatch('reschedule', this.ids.token(), { now: NOW_MS })
    b.cas(
      'suspend',
      'runs',
      `UPDATE runs SET
         state = CASE WHEN ${wakePlan.expression} <= ${NOW} THEN 'pending' ELSE 'sleeping' END,
         available_at_ms = ${wakePlan.expression},
         wake_event = NULL, event_payload = NULL, wake_step = NULL,
         ${PARKED_CLAIM},
         ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND ${storedInteger('runs.attempt')}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)})
         ${wakePlan.fits}`,
      [
        ...wakePlan.expressionArgs,
        ...wakePlan.expressionArgs,
        runId,
        queue,
        claimToken,
        ...wakePlan.fitArgs,
      ],
    )
    // A timer/deferral replaces any event wait attached to this run. Drive the
    // mirror and cleanup from the run this CAS actually suspended: a corrupt
    // pre-existing wait must not survive with the wake fields just cleared.
    finishSuspension(b, runId)
    const { won } = await b.run(this.db)
    if (won !== 'suspend') throw await this.refusal('reschedule', runId)
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
    wake: WakeSpec,
    checkpoint: CheckpointWrite,
  ): Promise<void> {
    const relativeWake = wakeHasOwn(wake, 'inSeconds')
    const wakePlan = prepareWake(wake, relativeWake)
    const b = new FencedBatch('suspend', this.ids.token(), { now: NOW_MS })
    b.cas(
      'suspend',
      'runs',
      `UPDATE runs SET
         state = CASE WHEN ${wakePlan.expression} <= ${NOW} THEN 'pending' ELSE 'sleeping' END,
         available_at_ms = ${wakePlan.expression},
         wake_event = NULL, event_payload = NULL, wake_step = NULL,
         ${PARKED_CLAIM},
         ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)})
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}
         AND ${validCheckpointConflict('runs', '?')}
         ${wakePlan.fits}`,
      [
        ...wakePlan.expressionArgs,
        ...wakePlan.expressionArgs,
        runId,
        queue,
        claimToken,
        checkpoint.key,
        ...wakePlan.fitArgs,
      ],
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
       FROM runs f WHERE ${BY_RUN}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'f')}
         AND f.fence_stamp = ${b.fence('suspend')}
       ${CHECKPOINT_LWW}`,
      [checkpoint.key, checkpoint.stateJson, runId],
      'one',
    )
    finishSuspension(b, runId)
    const { won } = await b.run(this.db)
    if (won !== 'suspend') throw await this.refusal('suspendRun', runId)
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
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')}
             AND (t.state NOT IN ${LIVE}
               OR (t.state IN ${LIVE} AND ${soleLiveRun('runs')}))
         )`,
      [resultJson, runId, queue, claimToken],
    )
    b.derived('task', {
      relation: 'runs-to-tasks',
      fence: 'complete',
      where: 'f.run_id = ?',
      whereArgs: [runId],
      set: { state: `'completed'`, completed_payload: '?', cancel_at_ms: 'NULL' },
      setArgs: [resultJson],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    waitsGone(b, runId, 'complete')
    const { won } = await b.run(this.db)
    if (won !== 'complete') throw await this.refusal('complete', runId)
  }

  /**
   * User-code failure. Retry POLICY is decided by the caller (core's
   * decideRetry over the user ordinal); the store applies the fenced
   * transition. This is the ONLY place tasks.attempts moves (the TLC-checked
   * AttemptAccounting shape). A retrying failure inserts the successor run
   * (attempt+1, carrying SUCCESSOR_CARRIED_RUN_COLUMNS) in the same batch.
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
    const retryDeadlineGuard =
      retryDelayMs === null
        ? ''
        : `AND ((runs.attempt - t.infra_retries) >= t.max_attempts
          OR ${epochAdditionFits(NOW, '?')})`
    const b = new FencedBatch('fail', this.ids.token(), { now: NOW_MS })
    b.cas(
      'fail',
      'runs',
      `UPDATE runs SET
         state = 'failed', failed_at_ms = ${NOW}, failure_reason = ?,
         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')}
             AND (t.state NOT IN ${LIVE}
               OR (t.state IN ${LIVE}
                 AND ${soleLiveRun('runs')}
                 AND ${storedCurrentRunAccounting('runs', 't')}
                 AND ${storedHighestOwnedOrdinal('runs')}
                 ${retryDeadlineGuard}))
         )`,
      [failureJson, runId, queue, claimToken, ...(retryDelayMs === null ? [] : [retryDelayMs])],
    )
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
            ${SUCCESSOR_PARENT_COLUMNS}, ${FENCE_COLS})
         SELECT ?, f.queue, f.task_id, f.attempt + 1,
                CASE WHEN ? <= 0 THEN 'pending' ELSE 'sleeping' END,
                f.fence_at_ms + ?,
                ${successorParentValues('f')},
                ${STAMP}, f.fence_at_ms
         FROM runs f JOIN tasks t ON ${runOwnedByTask('f', 't')}
         WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('fail')}
           AND t.state IN ${LIVE} AND (f.attempt - t.infra_retries) < t.max_attempts
           AND ${storedIncrementableInteger(RUN_INTEGER_BOUNDS.attempt, 'f')}
           AND NOT ${successorOwned('?', 'f.task_id', 'f.attempt + 1')}`,
        [successorId, retryDelayMs, retryDelayMs, runId, successorId],
        'one',
      )
      // attempts DERIVES from the failing run's own ordinal (the documented
      // user ordinal: run.attempt counts every successor, infra_retries the
      // infrastructure ones), so applying this twice equals applying it
      // once — an exact replay cannot double-count.
      b.derived('task-retrying', {
        relation: 'runs-to-tasks',
        fence: 'successor',
        where: 'f.run_id = ?',
        whereArgs: [successorId],
        set: {
          attempts: USER_ATTEMPTS_FROM('?', b.fence('fail')),
          state: `(SELECT f.state FROM runs f
                   WHERE f.run_id = ? AND f.fence_stamp = ${b.fence('successor')})`,
          last_attempt_run: '?',
        },
        setArgs: [runId, successorId, successorId],
        narrow: `state IN ${LIVE}`,
        rows: 'one',
      })
      // Cap refused (or task no longer live): terminal, same as no-retry.
      b.derived('task-terminal', {
        relation: 'runs-to-tasks',
        fence: 'fail',
        where: 'f.run_id = ?',
        whereArgs: [runId],
        set: {
          attempts: USER_ATTEMPTS_FROM('?', b.fence('fail')),
          state: `'failed'`,
          failure_reason: '?',
        },
        setArgs: [runId, failureJson],
        narrow: `state IN ${LIVE}
            AND NOT ${successorOwned(
              '?',
              'tasks.task_id',
              '(SELECT p.attempt + 1 FROM runs p WHERE p.run_id = ?)',
            )}`,
        narrowArgs: [successorId, runId],
        rows: 'one',
      })
    } else {
      b.derived('task', {
        relation: 'runs-to-tasks',
        fence: 'fail',
        where: 'f.run_id = ?',
        whereArgs: [runId],
        set: {
          attempts: USER_ATTEMPTS_FROM('?', b.fence('fail')),
          state: `'failed'`,
          failure_reason: '?',
        },
        setArgs: [runId, failureJson],
        narrow: `state IN ${LIVE}`,
        rows: 'one',
      })
    }
    waitsGone(b, runId, 'fail')
    const { won } = await b.run(this.db)
    if (won !== 'fail') throw await this.refusal('fail', runId)
  }

  async getCheckpoints(queue: string, taskId: string, attempt: number): Promise<Checkpoint[]> {
    const visibleThrough = requireRunOrdinal('getCheckpoints.attempt', attempt)
    const [rows] = await this.db.batch(
      'get-checkpoints',
      [
        {
          sql: `SELECT c.checkpoint_name, c.state, c.owner_run_id, c.owner_attempt
                FROM checkpoints c
                JOIN runs owner
                  ON ${checkpointOwnerMatches('c', 'owner')}
                WHERE c.task_id = ? AND c.queue = ? AND c.status = 'committed'
                  AND c.owner_attempt <= ?
                ORDER BY c.checkpoint_name`,
          args: [taskId, queue, visibleThrough],
        },
      ],
      'read',
    )
    return (rows?.rows ?? []).map((row) => ({
      checkpointName: String(row.checkpoint_name),
      stateJson: String(row.state),
      ownerRunId: String(row.owner_run_id),
      ownerAttempt: persistedRowInteger(
        'getCheckpoints',
        row,
        CHECKPOINT_INTEGER_BOUNDS.owner_attempt,
      ),
    }))
  }

  /**
   * Lease-fenced checkpoint upsert (§3.4 rule 5). Throws LeaseLostError when
   * the lease is gone (AB002).
   *
   * This was the last hand-rolled multi-statement write, exempt because rule 5
   * says the claim token IS the stamp here: the lease has to survive the batch
   * because the worker keeps working, so there was nowhere to put a per-batch
   * stamp. `fence_stamp` is that place, and it does not compete with the
   * lease — claimed_by is untouched, exactly the freedom activate gained. The
   * exemption was a workaround for a problem that no longer exists.
   *
   * The upsert's task id and queue now come from the RUN ROW the
   * compare-and-set stamped rather than from the caller's arguments. Rule 5
   * requires the fence to bind the full surface — run id, task id, queue and
   * token — and the compare-and-set checked all four, so reading them back off
   * the winning row is that requirement met by construction instead of by
   * repeating four guards in a second statement. `updated_at_ms` comes from
   * `fence_at_ms` rather than from the heartbeat column it was borrowing,
   * which was itself a smaller instance of the borrowed-column problem this
   * whole change exists to remove.
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
    const b = new FencedBatch('set-checkpoint', this.ids.token(), { now: NOW_MS })
    b.cas(
      'lease',
      'runs',
      `UPDATE runs SET
         claim_expires_at_ms = ${NOW} + ?, heartbeat_at_ms = ${NOW}, ${FENCE_SET}
       WHERE run_id = ? AND queue = ? AND task_id = ? AND claimed_by = ?
         AND state = 'running'
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})
         AND ${validCheckpointConflict('runs', '?')}
         AND ${epochAdditionFits(NOW, '?')}`,
      [extendMs, runId, queue, taskId, claimToken, checkpointName, extendMs],
    )
    // The attempt comparison inside CHECKPOINT_LWW is the last-writer-wins
    // tiebreaker, never the fence: a lower-attempt writer under a still-valid
    // lease is dropped silently and its lease still extends.
    b.followOn(
      'checkpoint',
      `INSERT INTO checkpoints
         (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
       SELECT f.task_id, ?, f.queue, ?, f.run_id, f.attempt, f.fence_at_ms
       FROM runs f WHERE ${BY_RUN}
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'f')}
         AND f.fence_stamp = ${b.fence('lease')}
       ${CHECKPOINT_LWW}`,
      [checkpointName, stateJson, runId],
      'one',
    )
    const { won } = await b.run(this.db)
    if (won !== 'lease') throw await this.refusal('setCheckpoint', runId)
  }

  async getTaskResult(queue: string, taskId: string): Promise<TaskResult | null> {
    const [rows] = await this.db.batch(
      'task-result',
      [
        {
          sql: `SELECT ${TASK_RESULT_COLUMNS} FROM tasks
                WHERE task_id = ? AND queue = ?`,
          args: [taskId, queue],
        },
      ],
      'read',
    )
    const row = rows?.rows[0]
    return row === undefined ? null : decodeTaskResult(taskId, row)
  }

  async nextWakeAtEpochMs(queue: string): Promise<number | null> {
    const [rows] = await this.db.batch(
      'next-wake',
      [{ sql: NEXT_WAKE_SQL, args: [queue, queue, queue, queue] }],
      'read',
    )
    const value = rows?.rows[0]?.wake_ms
    return value === null || value === undefined
      ? null
      : requireDerivedInteger('nextWakeAtEpochMs.wake_ms', value, DERIVED_INTEGER_BOUNDS.epoch_ms)
  }

  // ── events (implements the TLC-verified EmitEvent / AwaitEvent actions) ─

  /**
   * First write wins (EventImmutable): later emits cannot change the stored
   * payload, and every waiter receives that payload (PayloadMatchesEvent).
   * A fresh invocation may establish a fresh delivery fence at the event's
   * original instant. The same batch delivers to all registered waiters:
   * their runs wake with the event and its payload, their tasks mirror to
   * pending, and the wait rows are consumed — one atomic action, so an
   * interleaved await either sees the event row or gets woken, never neither.
   */
  async emitEvent(queue: string, eventName: string, payloadJson: string): Promise<void> {
    if (typeof payloadJson !== 'string') {
      throw new RangeError('emitEvent payloadJson must be a string')
    }
    const b = new FencedBatch('emit-event', this.ids.token(), { now: NOW_MS })
    // First write wins on the PAYLOAD; a genuinely new re-emit re-stamps only,
    // so a repaired/restored wait remains deliverable. Every conflict keeps
    // the event's immutable emitted_at_ms as its provenance instant. The
    // same-token guard avoids an unnecessary write while that token is
    // current; the stored instant is what stays correct even after another
    // invocation overwrites the token and the older batch replays.
    b.cas(
      'event',
      'events',
      `INSERT INTO events (queue, event_name, payload, emitted_at_ms, ${FENCE_COLS})
       VALUES (?, ?, ?, ${NOW}, ${FENCE_VALS})
       ON CONFLICT (queue, event_name) DO UPDATE SET ${fenceSetAt('events')}
       WHERE events.fence_stamp IS NOT ${STAMP}
         AND typeof(events.payload) = 'text'
         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`,
      [queue, eventName, payloadJson],
    )
    const thisEvent = `f.queue = runs.queue AND f.event_name = ?`
    const emitted = fencedAt('events', thisEvent, b.fence('event'))
    const runWait = registeredWait('runs')
    // THE ONE FOLLOW-ON THAT CANNOT BE GENERATED, and the reason is worth
    // stating rather than hiding. Every other follow-on selects its rows from
    // a table THIS batch stamped, so the primitive can build the selection
    // from the fence and the caller cannot widen it. This one selects from
    // `waits` — rows some earlier await registered, which this batch never
    // touched — and uses the event's fence only as a gate. That is a genuine
    // exception, not an oversight, so it keeps the hand-written WHERE and the
    // text checks that guard it. One documented escape is a better shape than
    // a scanner defending every statement, which is the trade `openTail`
    // already makes for reads.
    //
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
    //
    // The step match is a SEPARATE existence probe rather than extra
    // conditions on the IN subquery, and the difference is the whole query
    // plan. Correlating that subquery to `runs` demotes it from the DRIVER to
    // a filter, so the statement goes from `SEARCH runs USING PRIMARY KEY`
    // over the handful of waiters to `SCAN runs USING INDEX runs_poll` — a
    // full pass over the largest table in the engine, on every emit. Keeping
    // it uncorrelated leaves the waits index driving and makes the step match
    // a primary-key probe. Measured both ways.
    //
    // THE WITNESS IS THE WHOLE DECISION AND THE IN IS ONLY AN ACCESS PATH.
    // Its full correlation is generated by registeredWait; otherwise two
    // partial rows can answer separate probes, or a foreign-owned row can
    // pass this wake while remaining invisible to the step backfill.
    //
    // A NULL wake_step matches ANY step of the event. Waits and events
    // predate the wake_step column and its migration backfills nothing, so a
    // run parked by the older code carries wake_event with no step, and
    // `s.step_name = NULL` is never true. Without this arm such a run is
    // never woken by any emit — on any upgraded database, and on any rolling
    // deploy where an older process parks a run after a newer one migrated.
    //
    // It used to be worse than unwoken: the cleanup deleted its wait anyway,
    // leaving an untimed await with nothing that a future delivery could use.
    // The cleanup now follows the wake, so a run this predicate declines keeps
    // its registration and shows up under `wait-for-fired-event`. Before
    // consuming a legacy registration, the update copies its exact step into
    // the run through the same full witness claim uses for timed wakes. That
    // keeps the decoder from fabricating a step when an event name appeared at
    // several call sites.
    b.followOn(
      'wake-runs',
      'runs',
      `UPDATE runs SET
         state = 'pending',
         available_at_ms = ${emitted},
         wake_step = COALESCE(wake_step, ${runWait.step}),
         wake_event = ?,
         event_payload = (SELECT f.payload FROM events f
                          WHERE ${thisEvent}),
         ${fenceFrom('events', thisEvent, b.fence('event'))}
       WHERE state = 'sleeping'
         AND wake_event = ?
         AND run_id IN (SELECT w.run_id FROM waits w
                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting')
         AND ((runs.wake_step IS NOT NULL AND ${runWait.current})
              OR (runs.wake_step IS NULL AND ${runWait.step} IS NOT NULL))
         AND ${fenced('events', thisEvent, b.fence('event'))}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,
      [eventName, eventName, eventName, eventName, eventName, queue, eventName, eventName],
      { many: 'an emit wakes every registered waiter' },
    )
    // Driven by the runs this batch actually woke, and never by waits.task_id.
    // Reading the task id straight off the wait row meant a corrupt wait —
    // one belonging to run A but naming healthy task B — flipped B to pending
    // while B's own run kept running: corrupt state amplified into a task
    // that was never waiting at all.
    b.derived('wake-tasks', {
      relation: 'runs-to-tasks',
      // UPDATE provenance is generated from the runs this statement follows.
      // Every woken run carries the event's instant, so this is the same value
      // without a caller-controlled stamping escape.
      fence: 'wake-runs',
      // The queue narrows the source to an index rather than scanning runs;
      // `state = 'pending'` is what wake-runs just set on exactly these rows.
      where: `f.queue = ? AND f.state = 'pending'`,
      whereArgs: [queue],
      set: { state: `'pending'` },
      narrow: `state IN ${LIVE}`,
      rows: 'source-keys',
    })
    // DELETE, not a status flip: the wake fields on the run carry the
    // delivery, and retained rows would leak forever (cancel deletes waits
    // the same way).
    //
    // Driven by the runs this emit WOKE, not by the event it fired. Keying it
    // on the event name made the delete a second statement deciding which
    // registrations count, under a weaker rule than the one above it — so
    // every condition added to the wake predicate turned some run from "not
    // woken" into "not woken, and its registration destroyed", and the event
    // row is immutable, so nothing can deliver it afterwards. Every
    // legitimate end of a wait already reaps its rows (complete, fail, both
    // sweeps, cancel), so a row left here is either repairable or evidence of
    // corruption, and deleting it is the only option that makes it neither.
    //
    // It also stops being the second statement in this batch selecting rows
    // the batch did not write: the runs it deletes for are the ones
    // `wake-runs` just stamped, so the primitive builds the selection and
    // `wake-runs` is left as the only hand-written escape.
    b.derived('waits-gone', {
      relation: 'runs-to-waits',
      fence: 'wake-runs',
      // Same reason as wake-tasks: the queue narrows the source to an index,
      // and `state = 'pending'` is what wake-runs just set on these rows.
      where: `f.queue = ? AND f.state = 'pending'`,
      whereArgs: [queue],
      narrow: `event_name = ? AND status = 'waiting'`,
      narrowArgs: [eventName],
      rows: 'source-keys',
    })
    // `wake-runs` is an intermediate capability, not durable state. Once both
    // dependents have consumed it, overwrite that statement stamp at the same
    // instant. A delayed delivery of these exact compiled statements can no
    // longer treat the first execution's wake as work performed by the replay.
    b.seal('wake-finished', {
      relation: 'runs-to-runs',
      fence: 'wake-runs',
      where: `f.queue = ? AND f.state = 'pending'`,
      whereArgs: [queue],
      rows: 'source-keys',
    })
    b.openTail(
      'stored-event',
      'a replay may read an event stamped by the earlier delivery, but its immutable payload must still be TEXT',
      `SELECT typeof(payload) AS payload_type
       FROM events WHERE queue = ? AND event_name = ?`,
      [queue, eventName],
    )
    const { results } = await b.run(this.db)
    const stored = results['stored-event']?.rows[0]
    if (stored?.payload_type !== 'text') {
      throw new RangeError(`emitEvent ${queue}/${eventName} found a non-TEXT stored payload`)
    }
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
                     JOIN tasks t ON ${runOwnedByTask('r', 't')}
                     WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?
                       AND r.claimed_by = ? AND r.state = 'running'
                       AND ${eligibleTask('t', NOW)})
         AND (? IS NULL OR ${epochAdditionFits(NOW, '?')})
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
        timeoutMs,
        timeoutMs,
      ],
    )
    // available_at_ms IS this wait's own timeout_at_ms — copied from the row
    // just inserted, so the two can never drift and the park physically
    // cannot name the clock. claimed_by becomes NULL because a parked run
    // holds no lease; it used to receive a second, hand-rolled stamp, which
    // was this primitive reimplemented by hand.
    const thisWait = `f.run_id = ? AND f.step_name = ?`
    b.derived('park', {
      relation: 'waits-to-runs',
      fence: 'register',
      where: `f.run_id = ? AND f.step_name = ? AND f.status = 'waiting'`,
      whereArgs: [runId, stepName],
      set: {
        state: `'sleeping'`,
        available_at_ms: `(SELECT f.timeout_at_ms FROM waits f
                           WHERE ${thisWait} AND f.fence_stamp = ${b.fence('register')})`,
        wake_event: '?',
        event_payload: 'NULL',
        wake_step: '?',
        claimed_by: 'NULL',
        claim_expires_at_ms: 'NULL',
        heartbeat_at_ms: 'NULL',
      },
      setArgs: [runId, stepName, eventName, stepName],
      narrow: `queue = ? AND task_id = ? AND claimed_by = ? AND state = 'running'
            AND EXISTS (SELECT 1 FROM tasks t
                        WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,
      narrowArgs: [queue, taskId, claimToken],
      rows: 'one',
    })
    b.derived('task-mirror', {
      relation: 'runs-to-tasks',
      fence: 'park',
      where: `f.run_id = ? AND f.state = 'sleeping'`,
      whereArgs: [runId],
      set: { state: `'sleeping'` },
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    // The event row belongs to whichever batch emitted it, so this read is
    // fenced on the LIVE claim token instead: a zombie falls through to the
    // register discriminator and gets the lease error, never a success signal.
    b.openTail(
      'hit',
      'the event was written by the emitting batch, not this one; the live claim token is the fence here',
      `SELECT payload, typeof(payload) AS payload_type FROM events
       WHERE queue = ? AND event_name = ?
         AND EXISTS (SELECT 1 FROM runs r
                     JOIN tasks t ON ${runOwnedByTask('r', 't')}
                     WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?
                       AND r.claimed_by = ? AND r.state = 'running'
                       AND t.state IN ${LIVE})`,
      [queue, eventName, runId, queue, taskId, claimToken],
    )
    const { won, results } = await b.run(this.db)
    const row = results.hit?.rows[0]
    if (row !== undefined) {
      if (row.payload_type !== 'text') {
        throw new RangeError(`awaitEvent ${queue}/${eventName} found a non-TEXT stored payload`)
      }
      return { emitted: true, payloadJson: String(row.payload) }
    }
    if (won !== 'register') {
      throw await this.refusal('awaitEvent', runId)
    }
    return { emitted: false }
  }
}

/**
 * Decode one persisted field through the bounds branded for that exact field.
 *
 * The query supplies only its row and a field descriptor. The descriptor owns
 * both the row key and the interval, so a caller cannot decode one property
 * through another property's coincidentally equal bounds.
 */
export function persistedRowInteger(
  scope: string,
  row: SqlRow,
  bounds: PersistedIntegerBoundsExceptClaimGeneration,
): number {
  return decodePersistedRowInteger(scope, row, bounds)
}

function persistedPositiveClaimGeneration(scope: string, row: SqlRow): number {
  return decodePersistedRowInteger(scope, row, POSITIVE_CLAIM_GENERATION_BOUNDS)
}

function decodePersistedRowInteger(
  scope: string,
  row: SqlRow,
  bounds: PersistedIntegerBounds,
): number {
  const separator = bounds.field.indexOf('.')
  if (separator < 0 || separator === bounds.field.length - 1) {
    throw new Error(`persisted integer field must be table-qualified, got ${bounds.field}`)
  }
  const column = bounds.field.slice(separator + 1)
  const value = row[column]
  const decoded = decodeBoundedInteger(value, bounds)
  if (decoded.ok) return decoded.value
  throw new RangeError(
    `${scope}.${column} must be an exact SQL integer in [${bounds.min}, ${bounds.max}], got ${storageValueKind(value)} (${decoded.reason})`,
  )
}

function decodeClaimedRun(row: SqlRow, claimToken: string): ClaimedRun {
  const claimed: ClaimedRun = {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    taskName: String(row.task_name),
    attempt: persistedRowInteger('claim', row, RUN_INTEGER_BOUNDS.attempt),
    infraRetries: persistedRowInteger('claim', row, TASK_INTEGER_BOUNDS.infra_retries),
    claimGen: persistedPositiveClaimGeneration('claim', row),
    claimToken,
    claimExpiresAtEpochMs: persistedRowInteger(
      'claim',
      row,
      RUN_INTEGER_BOUNDS.claim_expires_at_ms,
    ),
    leaseSeconds: persistedRowInteger('claim', row, RUN_INTEGER_BOUNDS.lease_ms) / 1000,
    paramsJson: String(row.params),
    retryStrategy: normalizeRetryStrategy(parseTaskValueJson(String(row.retry_strategy))),
    maxAttempts: persistedRowInteger('claim', row, TASK_INTEGER_BOUNDS.max_attempts),
    headers:
      row.headers === null
        ? {}
        : (parseTaskValueJson(String(row.headers)) as Record<string, string>),
  }
  if (row.wake_event !== null && row.wake_step !== null) {
    // The SDK matches on the exact step key. Rows parked before schema v3
    // carry it only in waits, so claim and emit copy it into the run before
    // deleting that registration. Never fabricate a step from the event name:
    // repeated awaits may share the event while using distinct step keys.
    const event = String(row.wake_event)
    const step = String(row.wake_step)
    claimed.wake =
      row.event_payload === null
        ? { event, step, timedOut: true }
        : { event, step, payloadJson: String(row.event_payload) }
  }
  return claimed
}

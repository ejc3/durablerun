import {
  type Buggify,
  type Checkpoint,
  type CheckpointWrite,
  type ClaimedRun,
  DERIVED_INTEGER_BOUNDS,
  FencedBatch,
  INFRA_BACKOFF_SECONDS,
  type IdSource,
  InvalidDurableStringError,
  LIVE_STATES,
  LOST_LEASE,
  type LeaseState,
  MAX_DURATION_MS,
  NOW,
  PARKED_CLAIM_CLEARED_TEXT,
  PERSISTED_INTEGER_BOUNDS,
  POSITIVE_CLAIM_GENERATION_BOUNDS,
  type PersistedIntegerBounds,
  type PersistedIntegerBoundsExceptClaimGeneration,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_BACKOFF_MAX_SECONDS,
  type SchedulerStore,
  type SpawnOptions,
  type SpawnResult,
  type SqlExecutor,
  type SqlRow,
  type SweptRun,
  TASK_RESULT_COLUMNS,
  type TaskResult,
  type WakeSpec,
  activateCas,
  activatedRunRead,
  cancelCas,
  capLostLaunchCas,
  checkpointLeaseCas,
  checkpointWrite,
  claimCas,
  claimReceiptRead,
  claimTimeoutSuccessorInsert,
  clampLimit,
  coalesced,
  completeCas,
  decodeBoundedInteger,
  decodeTaskResult,
  deferLaunchCas,
  durationToMs,
  emitEventCas,
  emittedEventRead,
  failCas,
  failClaimTimeoutCas,
  mapLimit,
  neverBuggify,
  normalizeRetryStrategy,
  parseTaskValueJson,
  rawSql,
  refusedLease,
  refusedWriteError,
  registerWaitCas,
  reopenLostLaunchCas,
  requireDerivedInteger,
  requireDurableString,
  requireEpochMs,
  requirePositiveClaimGeneration,
  requirePositiveInt,
  requireRunOrdinal,
  revivalRunInsert,
  reviveCas,
  revivedRunRead,
  serializeTaskHeaders,
  serializeTaskValue,
  spawnReceiptRead,
  spawnRunInsert,
  spawnTaskCas,
  sqlFragment,
  storageValueKind,
  storedEventRead,
  suspendCas,
  userRetrySuccessorInsert,
  wakeRunsUpdate,
} from '@durablerun/core'
import {
  JSON_NUMBER_TYPES,
  LIVE,
  cancelDue,
  durableTaskHeadersAdmissible,
  durableTaskRetryAdmissible,
  eligibleTask,
  epochAdditionFits,
  fencedAt,
  jsonInputValid,
  persistedColumn,
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
import { IDENTIFIER_CHARACTERS } from './schema.js'
import { heartbeatCas, heartbeatRemainingRead } from './statements.js'
import { NOW_MS } from './time.js'
import { TREE_DIALECT } from './tree.js'

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
  /** The headroom guard, as one conjunct. */
  fitsConjunct: string
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
  const fitsConjunct = `(CASE WHEN ? = 1 THEN ${epochAdditionFits(NOW_MS, '?')} ELSE TRUE END)`
  return {
    // A batch label is the tracing and crash-injection address, so both wake
    // variants must compile to one statement inventory and bind shape. The
    // mode is data, not TypeScript control flow: relative wakes still derive
    // their absolute instant from database time, while absolute wakes are
    // stored verbatim after requireEpochMs validates them above.
    expression: `(CASE WHEN ? = 1 THEN ${NOW_MS} + ? ELSE ? END)`,
    expressionArgs: [mode, relativeMs, absoluteMs],
    fitsConjunct,
    fitArgs: [mode, relativeMs],
  }
}

/**
 * What a claim receipt must still satisfy before a transition acts on it: in-range
 * stored counters, no competing live run, and an eligible task whose stored retry
 * strategy, headers, accounting, and ordinal are sound. Activation and the launch
 * deferral take this one fragment, so within this dialect a guard added for one reaches
 * the other. The generated corpus holds both dialects' copies to the same shape.
 * `taskConjuncts` adds a transition's own task-side conjuncts.
 */
function claimReceiptAdmission(taskConjuncts: readonly string[] = []): string {
  const receipt = 'runs'
  const ownTaskConjuncts = taskConjuncts.map((conjunct) => `\n        AND ${conjunct}`).join('')
  return `(${storedPositiveClaimGeneration(receipt)}
    AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, receipt)}
    AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, receipt)}
    AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, receipt)}
    AND ${soleLiveRun(receipt)}
    AND EXISTS (
      SELECT 1 FROM tasks t
      WHERE ${runOwnedByTask(receipt, 't')} AND ${eligibleTask('t', NOW)}
        AND ${durableTaskRetryAdmissible('t')}
        AND ${durableTaskHeadersAdmissible('t')}
        AND ${storedCurrentRunAccounting(receipt, 't')}
        AND ${storedHighestOwnedOrdinal(receipt)}${ownTaskConjuncts}
    ))`
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
  const member = maxDurationMember(task)
  const seconds = `CAST(${member} AS DOUBLE)`
  const durationMs = taskMaxDurationMs(task)
  const firstStarted = `${task}.first_started_at_ms`
  return `(CASE
    WHEN ${cancellation} IS NULL THEN 1
    WHEN NOT ${jsonInputValid(cancellation)} THEN 0
    WHEN JSON_TYPE(CAST(${cancellation} AS JSON)) <> 'OBJECT' THEN 0
    WHEN ${member} IS NULL THEN 1
    WHEN JSON_TYPE(${member}) NOT IN ${JSON_NUMBER_TYPES} THEN 0
    WHEN (${seconds}) < 0 OR (${seconds}) > ${MAX_DURATION_MS} THEN 0
    WHEN (${durationMs}) > ${MAX_DURATION_MS} THEN 0
    WHEN NOT ${epochAdditionFits(`COALESCE(${firstStarted}, ${at})`, durationMs)} THEN 0
    ELSE 1
  END = 1)`
}

/** The stored duration clause, or SQL NULL when the policy has none. */
const maxDurationMember = (task: string): string =>
  `JSON_EXTRACT(${task}.cancellation, '$.maxDurationSeconds')`

function taskMaxDurationMs(task: string): string {
  return `CAST(ROUND(CAST(${maxDurationMember(task)} AS DOUBLE) * 1000) AS SIGNED)`
}

/**
 * Attempt counters DERIVED from a stamped run's ordinal, never bumped
 * (`x = x + 1` is not idempotent in a follow-on: an exact batch replay
 * re-matches its own stamped row and counts twice; FencedBatch rejects that
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

/** A run's own row, by id: the correlation `activate` reads its fenced instant by. */
const BY_RUN = `f.run_id = ?`

/** How this dialect names the type of an event's stored payload. Both reads of an event require 'text'. */
const STORED_PAYLOAD_TYPE = `CASE WHEN payload IS NULL THEN 'null' ELSE 'text' END`

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
 * This does not compare its ordinal with the incoming writer. The conflict arm of
 * `checkpointWrite` remains the tiebreaker. It only refuses malformed ownership before the
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
          SELECT 1 FROM (SELECT owner_run.* FROM runs owner_run
                         WHERE owner_run.run_id = c.owner_run_id) owner
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
 * A run's waits die with the run. Four transitions end a run (the relaunch
 * cap, the claim timeout, completion and failure) and each wrote this
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

/**
 * One wake source: the earliest stored instant of one state of one queue. MySQL does not
 * answer `MIN()` from an index once the bounds check stands beside it, and reads every
 * row of the state. The first row in index order is the same instant, and it is one seek,
 * because each index here is (queue, state, instant). Each leg binds the queue once.
 */
const wakeLeg = (
  table: 'runs' | 'tasks',
  index: string,
  state: string,
  bounds: PersistedIntegerBoundsExceptClaimGeneration,
): string => {
  const instant = persistedColumn(bounds, 'w')
  return `(SELECT ${instant} AS v FROM ${table} w FORCE INDEX (${index})
    WHERE w.queue = ? AND w.state = '${state}'
      AND ${storedIntegerWithin(bounds, 'w')}
    ORDER BY ${instant} LIMIT 1)`
}

const NEXT_WAKE_LEGS: readonly string[] = [
  wakeLeg('runs', 'runs_poll', 'pending', RUN_INTEGER_BOUNDS.available_at_ms),
  wakeLeg('runs', 'runs_poll', 'sleeping', RUN_INTEGER_BOUNDS.available_at_ms),
  wakeLeg('runs', 'runs_lease', 'running', RUN_INTEGER_BOUNDS.claim_expires_at_ms),
  ...LIVE_STATES.map((state) =>
    wakeLeg('tasks', 'tasks_cancel', state, TASK_INTEGER_BOUNDS.cancel_at_ms),
  ),
]

export const NEXT_WAKE_SQL = `SELECT MIN(v) AS wake_ms FROM (
  ${NEXT_WAKE_LEGS.join('\n  UNION ALL\n  ')}
) AS wakes`

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

/** The task still admits this run's completion: it is already terminal, or this is its only live run. */
const TASK_ADMITS_COMPLETION = `EXISTS (
  SELECT 1 FROM tasks t
  WHERE ${runOwnedByTask('runs', 't')}
    AND (t.state NOT IN ${LIVE}
      OR (t.state IN ${LIVE} AND ${soleLiveRun('runs')}))
)`

/**
 * Refuse an identifier the schema cannot hold, before any statement is sent. MySQL indexes
 * an identifier as VARCHAR(255). It refuses most longer values with error 1406, but it
 * cuts trailing spaces past the width with a note, in every `sql_mode`, and the cut value
 * is a different identifier: an event stored under another name, an idempotency key that
 * answers for another task. Refusing here, whatever the excess is, keeps the difference
 * from the other dialects a refusal. A value that is not a string is left to the
 * validation that already owns it.
 */
function requireIndexable(identifiers: Readonly<Record<string, unknown>>): void {
  for (const [what, value] of Object.entries(identifiers)) {
    if (
      typeof value === 'string' &&
      value.length > IDENTIFIER_CHARACTERS &&
      [...value].length > IDENTIFIER_CHARACTERS
    ) {
      throw new InvalidDurableStringError(
        `${what} is longer than the ${IDENTIFIER_CHARACTERS} characters a MySQL store indexes`,
      )
    }
  }
}

/**
 * SchedulerStore on MySQL 8 (DESIGN.md §3.4). Every method is ONE
 * atomic labeled batch; single-item transitions go through FencedBatch so
 * follow-ons structurally key on the batch's own stamp (§3.4 rule 1); all
 * timestamps come from NOW_MS (rule 3).
 */
export class MysqlSchedulerStore implements SchedulerStore {
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
    requireIndexable({ queue, idempotencyKey: opts.idempotencyKey })
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
    const headersJson =
      headersInput === undefined ? null : serializeTaskHeaders('task headers', headersInput)
    const b = new FencedBatch('spawn', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    // Idempotent task insert: loses silently when the key already exists.
    // enqueue/cancel deadlines are computed in SQL (rule 3); cancel_at_ms
    // materializes max_delay so sweeps and nextWakeAt are indexed reads, never
    // JSON scans. A task without max_delay binds NULL, and NULL propagates
    // through the addition, so its cancel_at_ms is NULL.
    //
    // The identity check is what makes a colliding task_id lose instead of
    // raising: the statement's conflict clause covers the idempotency index
    // only. Losing is the right answer, because some other task already
    // occupies that identity, and it is one the batch can reason about.
    b.casTree(
      'task',
      spawnTaskCas({
        taskId,
        queue,
        taskName: durableTaskName,
        paramsJson,
        headersJson,
        retryStrategyJson: retry,
        maxAttempts,
        cancellationJson,
        idempotencyKey: key,
        enqueueAt: sqlFragment(`${NOW} + ?`, [delayMs]),
        cancelAt: sqlFragment(`${NOW} + CAST(? AS SIGNED) + CAST(? AS SIGNED)`, [
          delayMs,
          maxDelayMs,
        ]),
        identityFree: sqlFragment(
          `NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ?)`,
          [taskId, taskId],
        ),
        enqueueFits: sqlFragment(epochAdditionFits(NOW, '?'), [delayMs]),
        cancelFits: sqlFragment(
          `CAST(? AS SIGNED) IS NULL OR ${epochAdditionFits(NOW, '?', '?')}`,
          [maxDelayMs, delayMs, maxDelayMs],
        ),
      }),
    )
    // The initial run, for the task THIS batch just created. One guard the
    // old version needed has deleted itself: the task cannot be terminal, we
    // inserted it 'pending' one statement ago.
    //
    // The "no run yet" guard stays, in ownership form, because the task's
    // STAMP does not distinguish this execution from the previous one. On an
    // exact replay after a lost response the task insert correctly writes
    // nothing (the task is already there) but the task still CARRIES the
    // first pass's stamp, so this statement matched and inserted the same run
    // again, dying on the run's primary key. The caller then saw an error for
    // a spawn that had fully succeeded, and a retry without an idempotency
    // key made duplicate work. Asking whether the task already has a run is a
    // question about ownership, which does not decay.
    b.followOnTree(
      'run',
      spawnRunInsert({
        runId,
        taskId,
        enqueueStored: sqlFragment(storedIntegerWithin(TASK_INTEGER_BOUNDS.enqueue_at_ms, 'f')),
      }),
      'one',
    )
    // Only reached when the insert lost, so by definition it reads a task some
    // OTHER caller created, fenced by the unique (queue, idempotency_key)
    // index, not by this batch's stamp. Ordering prefers the idempotency
    // winner over a bare id collision and breaks ties on task_id, so it is
    // deterministic on every dialect; an `ORDER BY (t.task_id = ?) DESC` would
    // not be, since Postgres sorts NULLs first.
    b.openTailTree(
      'receipt',
      'the winner is a task another caller created; the unique idempotency index is its fence, not this batch stamp',
      spawnReceiptRead({
        taskId,
        winner: sqlFragment(
          `(t.task_id = ? AND t.queue = ?)
         OR (CAST(? AS CHAR) IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?
           AND t.task_id <> ?)`,
          [taskId, queue, key, queue, key, taskId],
        ),
        taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
      }),
    )
    const { won, results } = await b.run(this.db)
    if (won === 'task') return { taskId, runId, created: true }

    const row = results.receipt?.rows[0]
    if (!row) throw new Error('spawn: the task insert lost but no existing task explains it')
    // A pre-existing task may legitimately have no run: swept away, or never
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
    requireIndexable({ queue })
    const leaseMs = durationToMs('leaseSeconds', opts.leaseSeconds, { positive: true })
    const limit = requirePositiveInt('limit', opts.limit)
    // Buggify: a short claim is always legal (limit is a maximum), so ticks
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
    const b = new FencedBatch('claim', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.lockClaim({ queue, claimToken })
    // Due runs of live tasks → running, holding the caller's lease token AND
    // this batch's provenance. The two are now different things, which is the
    // point: the token survives the batch by contract (the worker keeps
    // working), so it cannot tell one delivery of a claim from another.
    //
    // The candidates are a derived table for three reasons, each measured on a
    // real server. MySQL refuses LIMIT directly inside IN (error 1235), and
    // refuses a subquery over the table it updates (error 1093), and a derived
    // table with a LIMIT is materialized, which answers both. The locking read
    // is the third: without it two concurrent claims read the same candidates,
    // the second waits for the first's row locks, re-checks only the id list,
    // and overwrites the first's claim. SKIP LOCKED makes them select disjoint
    // queue slices.
    //
    // InnoDB locks a row when it reads it, before any sort or LIMIT. Measured:
    // with both states in one leg and the task joined, the plan sorts, so one
    // claim of two locked all forty due runs and a concurrent claim found none.
    // Each state is therefore its own leg, walking `runs_poll` in claim order
    // and stopping at the limit, with the task read through EXISTS so it cannot
    // become the driving table. That leg locked exactly the two runs it
    // returned. A leg may still lock up to the limit in runs the merged order
    // then leaves out. Those are skipped by other claimers until this
    // transaction commits, which a short claim allows.
    const candidateLeg = (state: 'pending' | 'sleeping'): string =>
      `(SELECT r.run_id, r.available_at_ms
        FROM runs r FORCE INDEX (runs_poll)
        WHERE r.queue = ? AND r.state = '${state}'
          AND ${runAvailableDue('r', NOW)}
          AND EXISTS (SELECT 1 FROM tasks t
                      WHERE ${runOwnedByTask('r', 't')} AND ${candidateEligibility})
        ORDER BY r.available_at_ms, r.run_id
        LIMIT ?
        FOR UPDATE SKIP LOCKED)`
    const candidateRunIds = sqlFragment(
      `(
         SELECT run_id FROM (
           SELECT legs.run_id FROM (
             ${candidateLeg('pending')}
             UNION ALL
             ${candidateLeg('sleeping')}
           ) AS legs
           ORDER BY legs.available_at_ms, legs.run_id
           LIMIT ?
         ) AS candidates
       )`,
      [queue, effectiveLimit, queue, effectiveLimit, effectiveLimit],
    )
    b.casManyTree(
      'claim',
      claimCas({
        queue,
        claimToken,
        leaseMs,
        candidateRunIds,
        legacyWaitStep: sqlFragment(claimedWait.step),
        leaseExpiresAt: sqlFragment(`${NOW} + ?`, [leaseMs]),
        leaseFits: sqlFragment(epochAdditionFits(NOW, '?'), [leaseMs]),
      }),
      effectiveLimit,
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
        // regression as the same poisoned-state change instead of relying on
        // a backend's treatment of a multi-row scalar subquery.
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
    // correctly took nothing, and it then compared their deadlines against a
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
    b.openTailTree(
      'picked',
      'rule 4: a same-token retry is a receipt and must return the original selection, which a previous batch stamped',
      claimReceiptRead({
        queue,
        claimToken,
        taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
        admission: sqlFragment(
          `t.state IN ${LIVE}
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
         AND ${storedHighestOwnedOrdinal('r')}`,
        ),
      }),
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
    requireIndexable({ queue, runId })
    const validClaimGen = requirePositiveClaimGeneration('activate.claimGen', claimGen)
    // Buggify: a lost activation is always legal: the launch channel may
    // drop any delivery; the sweep classifies and relaunches without cost.
    if (this.buggify('activate:lost')) return null
    const b = new FencedBatch('activate', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    // Per-claim latch: only this claim's first delivery passes; re-extends
    // the lease so channel-delayed launches don't start life nearly expired.
    // A launch whose task is already past its cancellation deadline must not
    // start: the sweep will cancel it. claimed_by is deliberately left alone:
    // the worker keeps its lease, which is exactly the freedom the batch
    // needed and did not have while claimed_by was also the stamp.
    b.casTree(
      'activate',
      activateCas({
        queue,
        runId,
        claimToken,
        claimGen: validClaimGen,
        admission: sqlFragment(claimReceiptAdmission([activationDurationAdmissible('t', NOW)])),
        leaseExpiresAt: sqlFragment(`${NOW} + lease_ms`),
        leaseFits: sqlFragment(epochAdditionFits(NOW, 'runs.lease_ms')),
      }),
    )
    // First-ever start stamps the task and REPLACES the deadline: max_delay is
    // disarmed by starting (its whole meaning is "cancel if never started");
    // max_duration runs from first start. The earlier MIN() kept the stale
    // spawn deadline and cancelled healthy running tasks.
    //
    // Fencing on this batch's own stamp is what makes that safe. The previous
    // fence was (claimed_by, activated_gen), values the WINNER wrote, so a
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
        // Built from nodes, because the value reads the column it is assigned to and the
        // counting rule cannot read that inside a fragment.
        first_started_at_ms: coalesced(
          'first_started_at_ms',
          rawSql<number>(sqlFragment(activated, [runId]), 'value'),
        ),
        // The leading CAS validated both this stored JSON value and the exact
        // headroom of the addition. Keep conversion in one shared expression
        // so the guard and write cannot disagree below a millisecond.
        cancel_at_ms: `CASE
          WHEN ${maxDurationMember('tasks')} IS NOT NULL THEN
            COALESCE(first_started_at_ms, ${activated}) + ${taskMaxDurationMs('tasks')}
          ELSE NULL
        END`,
      },
      setArgs: [runId],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    // Full payload for the winning worker. Fenced, so it can only return the
    // row THIS delivery activated: the post-state alone cannot tell "I won"
    // from "a previous delivery of the same claim won", since both leave
    // activated_gen equal to claim_gen.
    b.tailTree(
      'payload',
      activatedRunRead({ runId, taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')) }),
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
    requireIndexable({ queue, runId })
    // Buggify: lease-lost can arrive at ANY heartbeat: workers must abort
    // cleanly on the AB002 signal no matter when it fires.
    if (this.buggify('heartbeat:lease-lost')) return LOST_LEASE
    const extendMs = durationToMs('extendLeaseSeconds', extendLeaseSeconds, { positive: true })
    // MySQL has no RETURNING, so the remainder is a second statement, and a second
    // statement needs a fence on the first one's post-state. The compare-and-set
    // stamps the run and the read keys on that stamp. The read touches no clock:
    // it subtracts the two instants the update stored from one clock read.
    const b = new FencedBatch('heartbeat', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree(
      'extend',
      heartbeatCas({
        queue,
        runId,
        claimToken,
        leaseExpiresAt: sqlFragment(`${NOW} + ?`, [extendMs]),
        leaseFits: sqlFragment(epochAdditionFits(NOW, '?'), [extendMs]),
        taskIsLive: sqlFragment(
          `EXISTS (SELECT 1 FROM tasks t
                   WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,
        ),
      }),
    )
    b.tailTree('remaining', heartbeatRemainingRead({ runId }))
    const { won, results } = await b.run(this.db)
    const row = won === 'extend' ? results.remaining?.rows[0] : undefined
    if (!row) return refusedLease(() => this.refusalState(runId))
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
   * FencedBatch: the CAS stamps the row it kills (claimed_by carries the
   * sweep stamp; nothing reads claimed_by off non-running runs) and every
   * follow-on keys on the stamp, so a racing sweeper's whole batch matches
   * nothing structurally. One `limit` bounds TOTAL transitions across both
   * scans; per-item batches run through a bounded pipeline, never
   * sequentially (the reviewed RTT pileup).
   */
  async sweep(queue: string, limit: number): Promise<SweptRun[]> {
    requireIndexable({ queue })
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
          const batch = new FencedBatch('sweep:cancel', this.ids.token(), {
            now: NOW_MS,
            tree: TREE_DIALECT,
          })
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
    const b = new FencedBatch('sweep:lost-launch', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    const swept = { queue, runId: item.runId, claimGen: item.claimGen }
    const guard = `activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}`
    const launchLost = sqlFragment(guard)
    const relaunchDelayMs = `LEAST(
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
    // The launch never activated: reopen the SAME run (no new row, no
    // attempt consumed) with linear backoff on the relaunch counter. The
    // counter bump is safe in a CAS: its guard consumes the 'running' state,
    // so a replay matches nothing and cannot bump twice.
    b.casTree(
      'reopen',
      reopenLostLaunchCas({
        ...swept,
        launchLost,
        availableAt: sqlFragment(`${NOW} + ${relaunchDelayMs}`),
        liveOwner: sqlFragment(liveOwner),
        backoffFits: sqlFragment(epochAdditionFits(NOW, relaunchDelayMs)),
      }),
    )
    // Past the cap: a broken launcher must surface as failed work: the
    // task fails with the run (TLA-pinned), never an infinite launch loop.
    b.casTree(
      'cap',
      capLostLaunchCas({
        ...swept,
        launchLost,
        owner: sqlFragment(`${liveOwner} OR ${terminalOwner}`),
      }),
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
    const b = new FencedBatch('sweep:claim-timeout', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    const swept = { queue, runId: item.runId, claimGen: item.claimGen }
    // Ownership CAS: the activated worker died (or was partitioned). Clearing
    // claimed_by kills the dead worker's token, so its zombie writes are
    // doubly fenced from here on.
    b.casTree(
      'fail',
      failClaimTimeoutCas({
        ...swept,
        timedOut: sqlFragment(`activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}`),
        admission: sqlFragment(
          `EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')}
             AND ((t.state NOT IN ${LIVE}
                 AND ${sweepTerminalOwnerAdmissible('runs')})
               OR (t.state IN ${LIVE}
                 AND ${sweepLiveOwnerAdmissible('runs', 't')}
                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}
                   OR ${epochAdditionFits(NOW, infraDelayMs)})))
         )`,
        ),
      }),
    )
    // Successor under the infra cap, carrying the run-DB pointer and any
    // parked event wake (§3.8.2). Plain INSERT (not OR IGNORE; reviewed: OR
    // IGNORE also swallows PK collisions and books foreign rows), so a
    // collision with a FOREIGN row still fails loudly. Its instant is the
    // failed run's, so the backoff is measured from the moment of death and
    // not from a second clock read.
    b.followOnTree(
      'successor',
      claimTimeoutSuccessorInsert({
        successorId,
        runId: item.runId,
        availableAt: sqlFragment(`f.fence_at_ms + ${infraDelayMs}`),
        taskOwnsRun: sqlFragment(runOwnedByTask('f', 't')),
        admission: sqlFragment(
          `t.state IN ${LIVE}
         AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.infra_retries, 't')}
         AND t.infra_retries < ${TASK_INTEGER_BOUNDS.infra_retries.max}
         AND ${storedIncrementableInteger(RUN_INTEGER_BOUNDS.attempt, 'f')}`,
        ),
        successorFree: sqlFragment(`NOT ${successorOwned('?', 'f.task_id', 'f.attempt + 1')}`, [
          successorId,
        ]),
      }),
      'one',
    )
    // At the cap (pre-increment): terminal. Terminal ONLY when this batch
    // actually failed to place a successor: keying on the cap alone made an
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
    // conflates every other reason it can write nothing (the id already
    // belongs to a run of this task, or the task stopped being live partway)
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
   * subsequent heartbeat may legitimately re-extend: the lease remains the
   * sole authority and advisory signals never revoke it.
   */
  async expireLeaseNow(queue: string, runId: string, claimToken: string): Promise<boolean> {
    requireIndexable({ queue, runId })
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
   * protocol reads it: operators (and later, ops tooling) see the fleet.
   * Replay-safe: re-applying the same beat is the same row.
   */
  async driverHeartbeat(queue: string, driverId: string, ttlSeconds: number): Promise<void> {
    requireIndexable({ queue, driverId })
    const ttlMs = durationToMs('ttlSeconds', ttlSeconds, { positive: true })
    await this.db.batch('driver-heartbeat', [
      {
        sql: `INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
              SELECT * FROM (
                SELECT ? AS queue, ? AS driver_id, ${NOW_MS} AS last_beat_ms,
                       ${NOW_MS} + ? AS expires_at_ms
                WHERE ${epochAdditionFits(NOW_MS, '?')}
              ) AS beat
              ON DUPLICATE KEY UPDATE
                last_beat_ms = beat.last_beat_ms,
                expires_at_ms = beat.expires_at_ms`,
        args: [queue, driverId, ttlMs, ttlMs],
      },
      // Expired rows go in the same transaction, measured against the instant the
      // beat above stored and never against the clock. The headroom guard is
      // repeated, because the other dialects clean up only when the beat was
      // written, and a row from an earlier beat would otherwise stand in for one
      // this batch refused. It is the one clock read here, and it decides only
      // whether the instant is within a TTL of the epoch ceiling.
      //
      // The expired rows are found by a locking read that skips locked rows, and
      // deleted by primary key. A plain DELETE has no index to find them by, so it
      // locks every row it scans, and it waited on the rows other drivers had just
      // written in their own open transactions: 171 of 200 concurrent beats
      // deadlocked on MySQL 8.4. A skipped row is one another beat is writing, which
      // is not expired, or one another beat is burying. The statement waits on
      // nothing, so no cycle can form. NO_MERGE keeps the derived table
      // materialized, which is also how MySQL lets a DELETE read the table it writes
      // (error 1093 without it), and STRAIGHT_JOIN keeps the expired rows first, so
      // the delete never scans the table itself. The same locking read under
      // `WHERE (queue, driver_id) IN (...)` let the DELETE scan, and 22 of 200 beats
      // still deadlocked. This form measured 0 of 200.
      {
        sql: `DELETE /*+ NO_MERGE(expired) */ d FROM (
                SELECT stale.queue, stale.driver_id FROM drivers stale
                WHERE stale.expires_at_ms < (SELECT beat.last_beat_ms FROM drivers beat
                                             WHERE beat.queue = ? AND beat.driver_id = ?)
                  AND ${epochAdditionFits(NOW_MS, '?')}
                  AND stale.last_beat_ms BETWEEN 0 AND ${PERSISTED_INTEGER_BOUNDS.drivers.last_beat_ms.max}
                  AND stale.expires_at_ms BETWEEN 0 AND ${PERSISTED_INTEGER_BOUNDS.drivers.expires_at_ms.max}
                FOR UPDATE SKIP LOCKED
              ) AS expired
              STRAIGHT_JOIN drivers d
                ON d.queue = expired.queue AND d.driver_id = expired.driver_id`,
        args: [queue, driverId, ttlMs],
      },
    ])
  }

  async retryTask(
    queue: string,
    taskId: string,
  ): Promise<{ runId: string; attempt: number } | null> {
    requireIndexable({ queue, taskId })
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
    const b = new FencedBatch('retry-task', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    // Only a well-formed failure revives. A failed row with no reason, or with a
    // completed payload, is a corrupt outcome, and clearing the reason would pass
    // that corruption on to a pending task. The same holds for the counters: each
    // must be an exact integer in range, every owned run's ordinal too, the budget
    // must take one more, and the charge must be the recorded attempts or one more
    // and within the budget.
    b.casTree(
      'revive',
      reviveCas({
        queue,
        taskId,
        runId,
        charged: sqlFragment(charged),
        admission: sqlFragment(
          `${taskOwnsEveryRun('tasks')}
         AND failure_reason IS NOT NULL AND completed_payload IS NULL
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
        ),
      }),
    )
    // The revival run, keyed on the revive stamp, carries the top run's parked
    // wake as every successor does. The live-run check is ownership, so an exact
    // replay that still sees the first pass's stamp inserts nothing.
    b.followOnTree(
      'run',
      revivalRunInsert({
        runId,
        taskId,
        taskOwnsRun: sqlFragment(runOwnedByTask('p', 'f')),
        isTopRun: sqlFragment(`p.attempt = ${top('f')}`),
        noLiveRun: sqlFragment(noLiveRun('f')),
      }),
      'one',
    )
    b.tailTree('revived', revivedRunRead({ runId }))
    const { won, results } = await b.run(this.db)
    if (won !== 'revive') return null
    const row = results.revived?.rows[0]
    if (!row) throw new Error(`retryTask ${taskId}: the revival won but inserted no run`)
    return { runId, attempt: Number(row.attempt) }
  }

  async cancelTask(queue: string, taskId: string): Promise<boolean> {
    requireIndexable({ queue, taskId })
    const batch = new FencedBatch('cancel-task', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    return this.cancelTransition(batch, queue, taskId, false)
  }

  /**
   * Shared cancel transition. Two labels, 'cancel-task' (explicit API) and
   * 'sweep:cancel' (deadline enforcement), because a label is the crash
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
    const deadlineGuard = deadlineOnly ? `${cancelDue('tasks', NOW)} AND ` : ''
    b.casTree(
      'cancel',
      cancelCas({
        queue,
        taskId,
        admission: sqlFragment(`${deadlineGuard}${taskOwnsEveryRun('tasks')}`),
      }),
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
  private refusal(operation: string, runId: string): ReturnType<typeof refusedWriteError> {
    return refusedWriteError(operation, runId, () => this.refusalState(runId))
  }

  /** A refused run's state, read only after its fence refused a write or a heartbeat. */
  private async refusalState(runId: string): Promise<unknown> {
    const [rows] = await this.db.batch(
      'refusal-state',
      [{ sql: 'SELECT state FROM runs WHERE run_id = ?', args: [runId] }],
      'read',
    )
    return rows?.rows[0]?.state
  }

  async claimedTaskName(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
  ): Promise<string | null> {
    requireIndexable({ queue, runId })
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
    requireIndexable({ queue, runId })
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
    const b = new FencedBatch('defer-launch', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    b.casTree(
      'suspend',
      deferLaunchCas({
        queue,
        runId,
        claimToken,
        claimGen: validClaimGen,
        admission: sqlFragment(claimReceiptAdmission()),
        wakeAt: sqlFragment(wakePlan.expression, wakePlan.expressionArgs),
        wakeFits: sqlFragment(wakePlan.fitsConjunct, wakePlan.fitArgs),
      }),
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
    requireIndexable({ queue, runId })
    const relativeWake = wakeHasOwn(wake, 'inSeconds')
    const wakePlan = prepareWake(wake, relativeWake)
    // The task must be ELIGIBLE, not merely live: the same predicate
    // suspendRun uses, which is what its comment always claimed ("reschedule's
    // exact transition plus the marker") while the two guards had quietly
    // diverged. A suspension makes the run schedulable again, and the claim
    // path already refuses to launch a task whose cancellation deadline is
    // due; letting the run re-park itself would put it straight back into the
    // queue that path is keeping it out of. Refusing surfaces AB002, so the
    // worker stops now instead of being cancelled a moment later.
    const b = new FencedBatch('reschedule', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    b.casTree(
      'suspend',
      suspendCas({
        queue,
        runId,
        claimToken,
        wakeAt: sqlFragment(wakePlan.expression, wakePlan.expressionArgs),
        wakeFits: sqlFragment(wakePlan.fitsConjunct, wakePlan.fitArgs),
        admission: sqlFragment(
          `${storedInteger('runs.attempt')}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)})`,
        ),
      }),
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
   * marker, in one batch: the marker commits only if the park does. The
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
    requireIndexable({ queue, runId, checkpointName: checkpoint?.key })
    const relativeWake = wakeHasOwn(wake, 'inSeconds')
    const wakePlan = prepareWake(wake, relativeWake)
    const b = new FencedBatch('suspend', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree(
      'suspend',
      suspendCas({
        queue,
        runId,
        claimToken,
        wakeAt: sqlFragment(wakePlan.expression, wakePlan.expressionArgs),
        wakeFits: sqlFragment(wakePlan.fitsConjunct, wakePlan.fitArgs),
        admission: sqlFragment(
          `EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)})
         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}
         AND ${validCheckpointConflict('runs', '?')}`,
          [checkpoint.key],
        ),
      }),
    )
    // The marker's timestamp is the park's instant, taken from the row the
    // CAS stamped. This was the one follow-on with a legitimate need for the
    // batch's clock, and the reason fence_at_ms is a column rather than a
    // convention: without it, this statement would be a standing exemption to
    // "a follow-on may not read the clock".
    b.followOnTree(
      'marker',
      checkpointWrite({
        runId,
        checkpointName: checkpoint.key,
        stateJson: checkpoint.stateJson,
        fence: 'suspend',
        attemptStored: sqlFragment(storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'f')),
      }),
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
    requireIndexable({ queue, runId })
    const b = new FencedBatch('complete', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree(
      'complete',
      completeCas({
        runId,
        queue,
        claimToken,
        resultJson,
        taskAdmitsCompletion: sqlFragment(TASK_ADMITS_COMPLETION),
      }),
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
    requireIndexable({ queue, runId })
    const successorId = retry ? this.ids.uuidv7() : null
    const retryDelayMs = retry ? durationToMs('retry.delaySeconds', retry.delaySeconds) : null
    const retryDeadlineGuard =
      retryDelayMs === null
        ? ''
        : `AND ((runs.attempt - t.infra_retries) >= t.max_attempts
          OR ${epochAdditionFits(NOW, '?')})`
    const b = new FencedBatch('fail', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree(
      'fail',
      failCas({
        queue,
        runId,
        claimToken,
        failureJson,
        admission: sqlFragment(
          `EXISTS (
           SELECT 1 FROM tasks t
           WHERE ${runOwnedByTask('runs', 't')}
             AND (t.state NOT IN ${LIVE}
               OR (t.state IN ${LIVE}
                 AND ${soleLiveRun('runs')}
                 AND ${storedCurrentRunAccounting('runs', 't')}
                 AND ${storedHighestOwnedOrdinal('runs')}
                 ${retryDeadlineGuard}))
         )`,
          retryDelayMs === null ? [] : [retryDelayMs],
        ),
      }),
    )
    if (retry && successorId && retryDelayMs !== null) {
      // Only a LIVE task with user budget remaining gets a retry run. The cap
      // is expressed with the SAME user-ordinal definition the counter uses
      // (`run.attempt - infra_retries`) rather than `attempts + 1`: two
      // spellings of one quantity is how a stored counter that has drifted
      // one ahead (from the historical blind-increment bug) refuses the
      // last configured attempt while the accounting band still calls the
      // state legal. The delay runs from the failure's own instant.
      b.followOnTree(
        'successor',
        userRetrySuccessorInsert({
          successorId,
          runId,
          retryDelayMs,
          availableAt: sqlFragment(`f.fence_at_ms + ?`, [retryDelayMs]),
          taskOwnsRun: sqlFragment(runOwnedByTask('f', 't')),
          admission: sqlFragment(
            `t.state IN ${LIVE} AND (f.attempt - t.infra_retries) < t.max_attempts
           AND ${storedIncrementableInteger(RUN_INTEGER_BOUNDS.attempt, 'f')}`,
          ),
          successorFree: sqlFragment(`NOT ${successorOwned('?', 'f.task_id', 'f.attempt + 1')}`, [
            successorId,
          ]),
        }),
        'one',
      )
      // attempts DERIVES from the failing run's own ordinal (the documented
      // user ordinal: run.attempt counts every successor, infra_retries the
      // infrastructure ones), so applying this twice equals applying it
      // once: an exact replay cannot double-count.
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
    requireIndexable({ queue, taskId })
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
   * lease: claimed_by is untouched, exactly the freedom activate gained. The
   * exemption was a workaround for a problem that no longer exists.
   *
   * The upsert's task id and queue now come from the RUN ROW the
   * compare-and-set stamped rather than from the caller's arguments. Rule 5
   * requires the fence to bind the full surface (run id, task id, queue and
   * token) and the compare-and-set checked all four, so reading them back off
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
    requireIndexable({ queue, taskId, runId, checkpointName })
    const extendMs = durationToMs('extendLeaseSeconds', extendLeaseSeconds, { positive: true })
    const b = new FencedBatch('set-checkpoint', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    b.casTree(
      'lease',
      checkpointLeaseCas({
        queue,
        taskId,
        runId,
        claimToken,
        leaseExpiresAt: sqlFragment(`${NOW} + ?`, [extendMs]),
        admission: sqlFragment(
          `${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}
         AND EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})
         AND ${validCheckpointConflict('runs', '?')}`,
          [checkpointName],
        ),
        leaseFits: sqlFragment(epochAdditionFits(NOW, '?'), [extendMs]),
      }),
    )
    // The attempt comparison in checkpointWrite's conflict arm is the last-writer-wins
    // tiebreaker, never the fence: a lower-attempt writer under a still-valid
    // lease is dropped silently and its lease still extends.
    b.followOnTree(
      'checkpoint',
      checkpointWrite({
        runId,
        checkpointName: checkpointName,
        stateJson: stateJson,
        fence: 'lease',
        attemptStored: sqlFragment(storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'f')),
      }),
      'one',
    )
    const { won } = await b.run(this.db)
    if (won !== 'lease') throw await this.refusal('setCheckpoint', runId)
  }

  async getTaskResult(queue: string, taskId: string): Promise<TaskResult | null> {
    requireIndexable({ queue, taskId })
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
    requireIndexable({ queue })
    const [rows] = await this.db.batch(
      'next-wake',
      [{ sql: NEXT_WAKE_SQL, args: NEXT_WAKE_LEGS.map(() => queue) }],
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
   * pending, and the wait rows are consumed: one atomic action, so an
   * interleaved await either sees the event row or gets woken, never neither.
   */
  async emitEvent(queue: string, eventName: string, payloadJson: string): Promise<void> {
    requireIndexable({ queue, eventName })
    if (typeof payloadJson !== 'string') {
      throw new RangeError('emitEvent payloadJson must be a string')
    }
    const b = new FencedBatch('emit-event', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    b.lockEvent({ queue, eventName })
    // First write wins on the PAYLOAD; a genuinely new re-emit re-stamps only,
    // so a repaired/restored wait remains deliverable. Every conflict keeps
    // the event's immutable emitted_at_ms as its provenance instant. The
    // same-token guard avoids an unnecessary write while that token is
    // current; the stored instant is what stays correct even after another
    // invocation overwrites the token and the older batch replays.
    b.casTree(
      'event',
      emitEventCas({
        queue,
        eventName,
        payloadJson,
        existingEventAdmits: sqlFragment(
          `events.payload IS NOT NULL
         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`,
        ),
      }),
    )
    const runWait = registeredWait('runs')
    // THE ONE FOLLOW-ON THAT CANNOT BE GENERATED, and the reason is worth
    // stating rather than hiding. Every other follow-on selects its rows from
    // a table THIS batch stamped, so the primitive can build the selection
    // from the fence and the caller cannot widen it. This one selects from
    // `waits`, rows some earlier await registered and this batch never
    // touched, and uses the event's fence only as a gate. That is a genuine
    // exception, not an oversight. The shared statement `wakeRunsUpdate`
    // builds the gate, the payload, and the provenance from nodes, and this
    // site passes the predicates that stay store text.
    //
    // Waiters wake with the STORED payload, never the one this call carried:
    // on a re-emit they must agree with the event row. The waits index is the
    // access path; the event's stamp is the fence.
    //
    // `wake_event`/`wake_step` must match too. Trusting waits.run_id alone
    // meant a leftover waiting row naming a run woke that run whatever it was
    // actually doing, including a run asleep on a durable timer, which then
    // resumed however long early its timer had left. The wait row that proved
    // the mismatch was deleted in the same batch, so nothing afterwards looked
    // wrong. A run parked by awaitEvent carries the event and step it parked
    // on; a timer sleep carries neither.
    //
    // The step match is a SEPARATE existence probe rather than extra
    // conditions on the IN subquery, and the difference is the whole query
    // plan. Correlating that subquery to `runs` demotes it from the DRIVER to
    // a filter, so the statement goes from `SEARCH runs USING PRIMARY KEY`
    // over the handful of waiters to `SCAN runs USING INDEX runs_poll`, a
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
    // never woken by any emit, on any upgraded database, and on any rolling
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
    b.followOnTree(
      'wake-runs',
      wakeRunsUpdate({
        eventName,
        registeredStep: sqlFragment(runWait.step),
        parkedOnEvent: sqlFragment(`wake_event = ?`, [eventName]),
        waiterRunIds: sqlFragment(
          `(SELECT w.run_id FROM waits w
                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting')`,
          [queue, eventName],
        ),
        witness: sqlFragment(
          `(runs.wake_step IS NOT NULL AND ${runWait.current})
              OR (runs.wake_step IS NULL AND ${runWait.step} IS NOT NULL)`,
        ),
        taskIsLive: sqlFragment(
          `EXISTS (SELECT 1 FROM tasks t
                     WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,
        ),
      }),
      { many: 'an emit wakes every registered waiter' },
    )
    // Driven by the runs this batch actually woke, and never by waits.task_id.
    // Reading the task id straight off the wait row meant a corrupt wait,
    // one belonging to run A but naming healthy task B, flipped B to pending
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
    // registrations count, under a weaker rule than the one above it, so
    // every condition added to the wake predicate turned some run from "not
    // woken" into "not woken, and its registration destroyed", and the event
    // row is immutable, so nothing can deliver it afterwards. Every
    // legitimate end of a wait already reaps its rows (complete, fail, both
    // sweeps, cancel), so a row left here is either repairable or evidence of
    // corruption, and deleting it is the only option that makes it neither.
    //
    // It also stops being the second statement in this batch selecting rows
    // the batch did not write: the runs it deletes for are the ones
    // `wake-runs` just stamped, so the primitive builds the selection. No
    // follow-on of this batch is hand-written text: the wake is a shared statement.
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
    b.openTailTree(
      'stored-event',
      'a replay may read an event stamped by the earlier delivery, but its immutable payload must still be TEXT',
      storedEventRead({ queue, eventName, payloadType: sqlFragment(STORED_PAYLOAD_TYPE) }),
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
   * not, the wait registers and the run parks. The event-lock prelude
   * serializes this transaction against emit, so the wakeup cannot be lost
   * between the check and the park. A timed wait also sets available_at: the
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
    requireIndexable({ queue, taskId, runId, stepName, eventName })
    const timeoutMs =
      timeoutSeconds === null
        ? null
        : durationToMs('timeoutSeconds', timeoutSeconds, { positive: true })
    const b = new FencedBatch('await-event', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    b.lockEvent({ queue, eventName })
    // Wait registration FIRST, fenced on the LIVE claim token + running + task
    // eligible: a stale invocation whose token was consumed matches zero and
    // writes nothing, so a run left sleeping under the same wake_step (e.g. by
    // a preserve reschedule) cannot have a wait recreated on it. The single
    // eligibility decision (including the cancellation deadline, which is
    // database time) and the timeout deadline are computed exactly once here.
    //
    // ON CONFLICT DO NOTHING means a wait already at this (run, step) makes
    // this lose, and losing is now the whole answer: the park below keys on
    // the wait THIS statement inserted. It used to key on "some waiting wait
    // for this event exists", so a stale untimed wait left by an earlier
    // attempt was borrowed along with ITS null timeout, and a fresh
    // 30-second await parked the run forever.
    b.casTree(
      'register',
      registerWaitCas({
        queue,
        runId,
        taskId,
        claimToken,
        stepName,
        eventName,
        timeoutAt: sqlFragment(
          `CASE WHEN CAST(? AS SIGNED) IS NOT NULL THEN ${NOW} + ? ELSE NULL END`,
          [timeoutMs, timeoutMs],
        ),
        timeoutFits: sqlFragment(`CAST(? AS SIGNED) IS NULL OR ${epochAdditionFits(NOW, '?')}`, [
          timeoutMs,
          timeoutMs,
        ]),
        taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
        taskEligible: sqlFragment(eligibleTask('t', NOW)),
      }),
    )
    // available_at_ms IS this wait's own timeout_at_ms, copied from the row
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
        ...PARKED_CLAIM_CLEARED_TEXT,
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
    b.openTailTree(
      'hit',
      'the event was written by the emitting batch, not this one; the live claim token is the fence here',
      emittedEventRead({
        queue,
        eventName,
        runId,
        taskId,
        claimToken,
        payloadType: sqlFragment(STORED_PAYLOAD_TYPE),
        taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
        liveTask: sqlFragment(`t.state IN ${LIVE}`),
      }),
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

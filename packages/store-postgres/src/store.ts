import {
  type Buggify,
  CHECKPOINT_INTEGER_BOUNDS,
  type Checkpoint,
  type CheckpointWrite,
  type ClaimedRun,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY,
  DERIVED_INTEGER_BOUNDS,
  EventName,
  type FailOutcome,
  type FailedRollback,
  FencedBatch,
  INFRA_BACKOFF_SECONDS,
  type IdSource,
  LOST_LEASE,
  type LeaseState,
  MAX_DURATION_MS,
  NOW,
  PARKED_CLAIM_CLEARED_TEXT,
  PERSISTED_INTEGER_BOUNDS,
  READS_SEED,
  REASON_CANCELLED,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_BACKOFF_MAX_SECONDS,
  RUN_INTEGER_BOUNDS,
  RunTaskMemo,
  SAGA_PHASE_CHECKPOINT,
  SWEEP_PIPELINE_WIDTH,
  SWEEP_SCAN_DRIFT,
  type SchedulerStore,
  type SpawnOptions,
  type SpawnResult,
  type SqlExecutor,
  type SqlRow,
  type SweptRun,
  TASK_INTEGER_BOUNDS,
  type TaskDoneDialect,
  type TaskOutcome,
  type TaskResult,
  type WakeSpec,
  activateCas,
  activatedRunRead,
  addTaskDone,
  awaitTaskDone,
  cancelCas,
  capLostLaunchCas,
  checkpointLeaseCas,
  checkpointWrite,
  checkpointsRead,
  claimCas,
  claimReceiptRead,
  claimTimeoutSuccessorInsert,
  claimedTaskNameRead,
  clampLimit,
  coalesced,
  completeCas,
  completeTaskMirror,
  decodeClaimedRun,
  decodeRollbackOutcome,
  decodeTaskResult,
  deferLaunchCas,
  durationToMs,
  emitEventCas,
  emittedEventRead,
  endingTask,
  failedRollbackRecord,
  failCas,
  failClaimTimeoutCas,
  heartbeatCas,
  heartbeatRemainingRead,
  mapLimit,
  neverBuggify,
  nextWakeRead,
  normalizeRetryStrategy,
  persistedPositiveClaimGeneration,
  persistedRowInteger,
  prepareRead,
  rawSql,
  readRows,
  refusalStateRead,
  refusedLease,
  refusedWriteError,
  registerWaitCas,
  reopenLostLaunchCas,
  requireDerivedInteger,
  requireDurableString,
  requireFailedRollback,
  requireIdentifiersFit,
  requireSagaStepFits,
  requireEpochMs,
  requirePositiveClaimGeneration,
  requirePositiveInt,
  requireRunOrdinal,
  revivalRunInsert,
  reviveCas,
  revivedRunRead,
  rollbackPassInsert,
  serializeTaskHeaders,
  serializeTaskValue,
  spawnIdempotencyKey,
  spawnReceiptRead,
  spawnRunInsert,
  spawnTaskCas,
  sqlFragment,
  stampedRunState,
  storedEventRead,
  suspendCas,
  sweepDueCancelsRead,
  sweepExpiredClaimsRead,
  taskResultRead,
  taskStateValue,
  userRetrySuccessorInsert,
  wakeHasOwn,
  wakeRunsUpdate,
} from '@durablerun/core'
import {
  LIVE,
  QUEUED,
  cancelDue,
  checkpointInItsPhase,
  checkpointIsTheEngines,
  durableTaskHeadersAdmissible,
  durableTaskRetryAdmissible,
  eligibleTask,
  epochAdditionFits,
  fencedAt,
  jsonbInputValid,
  registeredWait,
  rollbackError,
  rollbackOutcome,
  rollbackPending,
  runAvailableDue,
  runClaimExpired,
  runClaimUnexpired,
  runOwnedByTask,
  runsLockedBeforeTask,
  sagaBegan,
  sagaBeganOf,
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
import { NOW_MS } from './time.js'
import { TREE_DIALECT } from './tree.js'

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
  const seconds = `((${cancellation}::jsonb ->> 'maxDurationSeconds')::numeric)`
  const durationMs = taskMaxDurationMs(task)
  const firstStarted = `${task}.first_started_at_ms`
  return `(CASE
    WHEN ${cancellation} IS NULL THEN 1
    WHEN NOT ${jsonbInputValid(cancellation)} THEN 0
    WHEN NOT (${cancellation} IS JSON OBJECT WITH UNIQUE KEYS) THEN 0
    WHEN (${cancellation}::jsonb -> 'maxDurationSeconds') IS NULL THEN 1
    WHEN jsonb_typeof(${cancellation}::jsonb -> 'maxDurationSeconds') <> 'number' THEN 0
    WHEN (${seconds}) < 0 OR (${seconds}) > ${MAX_DURATION_MS} THEN 0
    WHEN (${durationMs}) > ${MAX_DURATION_MS} THEN 0
    WHEN NOT ${epochAdditionFits(`COALESCE(${firstStarted}, ${at})`, durationMs)} THEN 0
    ELSE 1
  END = 1)`
}

function taskMaxDurationMs(task: string): string {
  return `CAST(ROUND(
    ((${task}.cancellation::jsonb ->> 'maxDurationSeconds')::numeric) * 1000
  ) AS BIGINT)`
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
function taskMirrorsRun(b: FencedBatch, queue: string, runId: string, after: string): void {
  b.derived('task-mirror', {
    relation: 'runs-to-tasks',
    fence: after,
    queue,
    where: 'f.run_id = ?',
    whereArgs: [runId],
    set: {
      state: stampedRunState(runId, after),
    },
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
function finishSuspension(b: FencedBatch, queue: string, runId: string): void {
  taskMirrorsRun(b, queue, runId, 'suspend')
  waitsGone(b, runId, 'suspend')
}

/**
 * Sweep discovery's predicates, as the fragments its two reads take (`sweepDueCancelsRead`
 * and `sweepExpiredClaimsRead`). Each binds the queue once. The query-plan suite pins the
 * statements a real sweep sends, which it records from the store.
 */
const SWEEP_CANCELS_DUE = `t.queue = ? AND ${cancelDue('t', NOW)}
  AND t.state IN ${LIVE}
  AND ${taskOwnsEveryRun('t')}`
const SWEEP_LIVE_RUN_OF_TASK = `${runOwnedByTask('r', 't')} AND r.state IN ${LIVE}`

/** `next-wake`'s four sources, as the predicates `nextWakeRead` takes. Each binds the queue once. */
const NEXT_WAKE_PENDING = `r.queue = ? AND r.state = 'pending'
  AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, 'r')}`
const NEXT_WAKE_SLEEPING = `r.queue = ? AND r.state = 'sleeping'
  AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, 'r')}`
const NEXT_WAKE_RUNNING = `r.queue = ? AND r.state = 'running'
  AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.claim_expires_at_ms, 'r')}`
const NEXT_WAKE_CANCELLABLE = `t.queue = ? AND t.state IN ${LIVE}
  AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.cancel_at_ms, 't')}`

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

const SWEEP_CLAIMS_EXPIRED = `r.queue = ? AND r.state = 'running'
  AND ${runClaimExpired('r', NOW)}
  AND ${sweepScanAdmissible('r', 't')}`

/**
 * The task still admits this run's completion: it is already terminal, or this is its
 * only live run and no saga began. A task that is rolling back cannot complete
 * (DESIGN.md §3.10, specs/Sagas.tla ForwardFrozenInSaga).
 */
const TASK_ADMITS_COMPLETION = `EXISTS (
  SELECT 1 FROM tasks t
  WHERE ${runOwnedByTask('runs', 't')}
    AND (t.state NOT IN ${LIVE} OR NOT ${sagaBegan('t')})
    AND (t.state NOT IN ${LIVE}
      OR (t.state IN ${LIVE} AND ${soleLiveRun('runs')}))
)`

/**
 * The reads this store sends outside a transition, each prepared once: built, checked and
 * compiled on first use, and sent with a call's own values after that. next-wake and the
 * sweep's two scans run on every driver tick.
 */
const REFUSAL_STATE = prepareRead({ runId: 'string' }, (binds: { runId: string }) =>
  refusalStateRead(binds),
)
const TASK_RESULT = prepareRead(
  { queue: 'string', taskId: 'string' },
  (binds: { queue: string; taskId: string }) =>
    taskResultRead({
      ...binds,
      rollbackOutcome: sqlFragment(rollbackOutcome('tasks')),
      rollbackError: sqlFragment(rollbackError('tasks')),
    }),
)
const CLAIMED_TASK_NAME = prepareRead(
  { queue: 'string', runId: 'string', claimToken: 'string', claimGen: 'number' },
  (binds: { queue: string; runId: string; claimToken: string; claimGen: number }) =>
    claimedTaskNameRead({ ...binds, taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')) }),
)
const CHECKPOINTS = prepareRead(
  { queue: 'string', taskId: 'string', visibleThrough: 'number' },
  (binds: { queue: string; taskId: string; visibleThrough: number }) =>
    checkpointsRead({ ...binds, ownerMatches: sqlFragment(checkpointOwnerMatches('c', 'owner')) }),
)
const SWEEP_DUE_CANCELS = prepareRead(
  { queue: 'string', limit: 'number' },
  (binds: { queue: string; limit: number }) =>
    sweepDueCancelsRead({
      limit: binds.limit,
      due: sqlFragment(SWEEP_CANCELS_DUE, [binds.queue]),
      liveRunOfTask: sqlFragment(SWEEP_LIVE_RUN_OF_TASK),
    }),
)
const SWEEP_EXPIRED_CLAIMS = prepareRead(
  { queue: 'string', limit: 'number' },
  (binds: { queue: string; limit: number }) =>
    sweepExpiredClaimsRead({
      limit: binds.limit,
      taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
      expired: sqlFragment(SWEEP_CLAIMS_EXPIRED, [binds.queue]),
    }),
)
const NEXT_WAKE = prepareRead({ queue: 'string' }, (binds: { queue: string }) =>
  nextWakeRead({
    pendingRuns: sqlFragment(NEXT_WAKE_PENDING, [binds.queue]),
    sleepingRuns: sqlFragment(NEXT_WAKE_SLEEPING, [binds.queue]),
    runningRuns: sqlFragment(NEXT_WAKE_RUNNING, [binds.queue]),
    cancellableTasks: sqlFragment(NEXT_WAKE_CANCELLABLE, [binds.queue]),
  }),
)

/**
 * SchedulerStore on PostgreSQL (DESIGN.md §3.4). Every method is ONE
 * atomic labeled batch; single-item transitions go through FencedBatch so
 * follow-ons structurally key on the batch's own stamp (§3.4 rule 1); all
 * timestamps come from NOW_MS (rule 3).
 */
export class PostgresSchedulerStore implements SchedulerStore {
  constructor(
    private readonly db: SqlExecutor,
    private readonly ids: IdSource,
    private readonly buggify: Buggify = neverBuggify,
  ) {}

  private readonly runTasks = new RunTaskMemo()
  private taskDoneFacts: TaskDoneDialect | undefined

  async spawn(
    queue: string,
    taskName: string,
    paramsJson: string,
    opts: SpawnOptions = {},
  ): Promise<SpawnResult> {
    requireIdentifiersFit({ queue })
    // The queue becomes durable here, so it is held to the domain every store keeps.
    requireDurableString('queue', queue)
    const durableTaskName = requireDurableString('taskName', taskName)
    const key = spawnIdempotencyKey(opts)
    const childOf = opts.childOf
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
        parent:
          childOf === undefined
            ? null
            : {
                queue: childOf.parentQueue,
                runId: childOf.runId,
                taskId: childOf.parentTaskId,
                claimToken: childOf.claimToken,
                taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
                liveTask: sqlFragment(`t.state IN ${LIVE}`),
                // A child is forward progress, and the forward phase is frozen once a saga began.
                phase: sqlFragment(`NOT ${sagaBeganOf('?')}`, [childOf.parentTaskId]),
              },
        enqueueAt: sqlFragment(`${NOW} + ?`, [delayMs]),
        cancelAt: sqlFragment(`${NOW} + CAST(? AS BIGINT) + CAST(? AS BIGINT)`, [
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
          `CAST(? AS BIGINT) IS NULL OR ${epochAdditionFits(NOW, '?', '?')}`,
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
    // nothing — the task is already there — but the task still CARRIES the
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
    // OTHER caller created — fenced by the unique (queue, idempotency_key)
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
         OR (CAST(? AS TEXT) IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?
           AND t.task_id <> ?)`,
          [taskId, queue, key, queue, key, taskId],
        ),
        taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
      }),
    )
    const { won, results } = await b.run(this.db)
    if (won === 'task') return { taskId, runId, created: true }

    const row = results.receipt?.rows[0]
    if (!row) {
      // A child is created only under its parent's live claim, so a child spawn that
      // created nothing and found nothing is that claim, refused.
      if (childOf !== undefined) throw await this.refusal('spawn', childOf.runId)
      throw new Error('spawn: the task insert lost but no existing task explains it')
    }
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
    requireIdentifiersFit({ queue })
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
    const b = new FencedBatch('claim', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.lockClaim({ queue, claimToken })
    // Due runs of live tasks → running, holding the caller's lease token AND
    // this batch's provenance. The two are now different things, which is the
    // point: the token survives the batch by contract (the worker keeps
    // working), so it cannot tell one delivery of a claim from another. The
    // The materialized candidate CTE takes PostgreSQL row locks before the
    // update. SKIP LOCKED makes concurrent claimers select disjoint queue
    // slices instead of re-evaluating and overwriting one another.
    const candidateRunIds = sqlFragment(
      `(
         WITH candidates AS MATERIALIZED (
           SELECT r.run_id
           FROM runs r JOIN tasks t ON ${runOwnedByTask('r', 't')}
           WHERE r.queue = ? AND r.state IN ${QUEUED}
             AND ${runAvailableDue('r', NOW)}
             AND ${candidateEligibility}
           ORDER BY r.available_at_ms, r.run_id
           LIMIT ?
           FOR UPDATE OF r SKIP LOCKED
         )
         SELECT run_id FROM candidates
       )`,
      [queue, effectiveLimit],
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
      queue,
      where: `f.queue = ? AND f.state = 'running'`,
      whereArgs: [queue],
      set: {
        state: taskStateValue('running'),
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
    requireIdentifiersFit({ queue, runId })
    const validClaimGen = requirePositiveClaimGeneration('activate.claimGen', claimGen)
    // Buggify: a lost activation is always legal — the launch channel may
    // drop any delivery; the sweep classifies and relaunches without cost.
    if (this.buggify('activate:lost')) return null
    const b = new FencedBatch('activate', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    // Per-claim latch: only this claim's first delivery passes; re-extends
    // the lease so channel-delayed launches don't start life nearly expired.
    // A launch whose task is already past its cancellation deadline must not
    // start: the sweep will cancel it. claimed_by is deliberately left alone —
    // the worker keeps its lease — which is exactly the freedom the batch
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
      queue,
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
          WHEN (cancellation::jsonb -> 'maxDurationSeconds') IS NOT NULL THEN
            COALESCE(first_started_at_ms, ${activated}) + ${taskMaxDurationMs('tasks')}
          ELSE NULL
        END`,
      },
      setArgs: [runId],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    // Full payload for the winning worker. Fenced, so it can only return the
    // row THIS delivery activated — the post-state alone cannot tell "I won"
    // from "a previous delivery of the same claim won", since both leave
    // activated_gen equal to claim_gen.
    b.tailTree(
      'payload',
      activatedRunRead({ runId, taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')) }),
    )
    const { won, results } = await b.run(this.db)
    if (won !== 'activate') return null
    const row = results.payload?.rows[0]
    const run = row ? decodeClaimedRun(row, claimToken) : null
    if (run !== null) this.runTasks.remember(run.runId, run.taskId)
    return run
  }

  async heartbeat(
    queue: string,
    runId: string,
    claimToken: string,
    extendLeaseSeconds: number,
  ): Promise<LeaseState> {
    requireIdentifiersFit({ queue, runId })
    // Buggify: lease-lost can arrive at ANY heartbeat — workers must abort
    // cleanly on the AB002 signal no matter when it fires.
    if (this.buggify('heartbeat:lease-lost')) return LOST_LEASE
    const extensionMs = durationToMs('extendLeaseSeconds', extendLeaseSeconds, { positive: true })
    // Two statements under one fence, the shape every dialect sends. The compare-and-set
    // extends the lease from one read of the clock and stamps the run. The read keys on
    // that stamp and subtracts the two instants the update stored. It touches no clock,
    // so the answer cannot drift from the write.
    const b = new FencedBatch('heartbeat', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree(
      'extend',
      heartbeatCas({
        queue,
        runId,
        claimToken,
        leaseExpiresAt: sqlFragment(`${NOW} + ?`, [extensionMs]),
        leaseFits: sqlFragment(epochAdditionFits(NOW, '?'), [extensionMs]),
        taskIsLive: sqlFragment(
          `EXISTS (SELECT 1 FROM tasks t
                   WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,
        ),
      }),
    )
    b.tailTree('remaining', heartbeatRemainingRead({ runId }))
    const { won, results } = await b.run(this.db)
    const row = won === 'extend' ? results.remaining?.rows[0] : undefined
    if (!row) return refusedLease(this.refusalState(runId))
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
    requireIdentifiersFit({ queue })
    const budget = clampLimit(limit)
    if (budget === 0) return []
    const effectiveBudget = budget > 1 && this.buggify('sweep:short-batch') ? 1 : budget
    const scan = new FencedBatch('sweep:scan', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT })
    scan.readPrepared('cancels', SWEEP_DUE_CANCELS, { queue, limit: effectiveBudget })
    scan.readPrepared(
      'expired',
      SWEEP_EXPIRED_CLAIMS,
      { queue, limit: effectiveBudget },
      SWEEP_SCAN_DRIFT,
    )
    const { cancels, expired } = (await scan.run(this.db)).results

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
    // The launch never activated: reopen the SAME run — no new row, no
    // attempt consumed — with linear backoff on the relaunch counter. The
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
    // Past the cap: a broken launcher must surface as failed work — the
    // task fails with the run (TLA-pinned), never an infinite launch loop.
    b.casTree(
      'cap',
      capLostLaunchCas({
        ...swept,
        launchLost,
        owner: sqlFragment(`${liveOwner} OR ${terminalOwner}`),
      }),
    )
    // The cap is a terminal decision, so it enters the rolling-back phase when a
    // registered step is owed its rollback (DESIGN.md §3.10, Sagas.tla InfraCap).
    const passId = this.ids.uuidv7()
    this.sagaPass(b, {
      queue,
      failedRunId: item.runId,
      passId,
      fence: 'cap',
      enteringWith: REASON_RELAUNCH_CAP,
      delayMs: 0,
      admission: `NOT ${sagaBegan('t')} AND ${rollbackPending('t')}`,
      admissionArgs: [],
    })
    // The task mirrors the run (the reviewed phantom-'running' divergence
    // from the TLA SweepLostLaunch action). Each arm names the CAS it
    // follows, so neither can fire for the other's outcome.
    b.derived('task-pending', {
      relation: 'runs-to-tasks',
      fence: 'reopen',
      queue,
      where: 'f.run_id = ?',
      whereArgs: [item.runId],
      set: { state: taskStateValue('pending') },
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    b.derived('task-fail', {
      relation: 'runs-to-tasks',
      fence: 'cap',
      queue,
      where: 'f.run_id = ?',
      whereArgs: [item.runId],
      set: { state: taskStateValue('failed'), failure_reason: '?' },
      setArgs: [REASON_RELAUNCH_CAP],
      // Terminal only when this batch placed no rollback pass.
      narrow: `state IN ${LIVE}
            AND NOT ${successorOwned(
              '?',
              'tasks.task_id',
              `(SELECT p.attempt + 1 FROM runs p
                WHERE p.run_id = ? AND p.fence_stamp = ${b.fence('cap')})`,
            )}`,
      narrowArgs: [passId, item.runId],
      rows: 'one',
    })
    waitsGone(b, item.runId, 'cap')
    this.taskDone(b, queue, item.taskId, 'task-fail', {
      state: 'failed',
      failureReasonJson: REASON_RELAUNCH_CAP,
    })
    const { won, results } = await b.run(this.db)
    if (won === 'reopen') {
      return {
        kind: 'lost-launch',
        runId: item.runId,
        taskId: item.taskId,
        relaunchCount: item.relaunchCount + 1,
      }
    }
    if (won === 'cap') {
      if ((results['task-rolling-back']?.rowsAffected ?? 0) === 1) {
        return {
          kind: 'rollback-started',
          runId: item.runId,
          taskId: item.taskId,
          successorRunId: passId,
        }
      }
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
    // parked event wake (§3.8.2). Plain INSERT (not OR IGNORE — reviewed: OR
    // IGNORE also swallows PK collisions and books foreign rows), so a
    // collision with a FOREIGN row still fails loudly. Its instant is the
    // failed run's, so the backoff is measured from the moment of death and
    // not from a second clock read.
    b.followOnTree(
      'successor',
      claimTimeoutSuccessorInsert({
        successorId,
        runId: item.runId,
        delayMs: INFRA_BACKOFF_SECONDS * 1000,
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
    // At the cap the batch decides the task's failure, so it enters the rolling-back
    // phase when a registered step is owed its rollback (DESIGN.md §3.10, Sagas.tla
    // InfraCap). The pass takes the identity the refused successor would have had, so
    // the terminal arm below yields to it as it yields to a successor. It follows the
    // successor's insert and shares its id, so it is placed only when no retry was: below
    // the cap the retry holds the id, and a death there is a retry, as it always was.
    this.sagaPass(b, {
      queue,
      failedRunId: item.runId,
      passId: successorId,
      fence: 'fail',
      enteringWith: REASON_INFRA_CAP,
      delayMs: 0,
      admission: `NOT ${sagaBegan('t')} AND ${rollbackPending('t')}`,
      admissionArgs: [],
    })
    // At the cap (pre-increment): terminal. Terminal ONLY when this batch
    // actually failed to place a successor — keying on the cap alone made an
    // exact replay terminalize the task over the successor the first pass had
    // just created (rule 6).
    b.derived('task-terminal', {
      relation: 'runs-to-tasks',
      fence: 'fail',
      queue,
      where: 'f.run_id = ?',
      whereArgs: [item.runId],
      set: { state: taskStateValue('failed'), failure_reason: '?' },
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
      queue,
      where: 'f.run_id = ?',
      whereArgs: [successorId],
      set: {
        infra_retries: INFRA_RETRIES_FROM('?', b.fence('successor')),
        state: taskStateValue('pending'),
        last_attempt_run: '?',
      },
      setArgs: [successorId, successorId],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
    // The dead run's waits die with it (the reviewed orphan-waits leak).
    waitsGone(b, item.runId, 'fail')
    this.taskDone(b, queue, item.taskId, 'task-terminal', {
      state: 'failed',
      failureReasonJson: REASON_INFRA_CAP,
    })
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
    if ((results['task-rolling-back']?.rowsAffected ?? 0) === 1) {
      return {
        kind: 'rollback-started',
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
    requireIdentifiersFit({ queue, runId })
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
    requireIdentifiersFit({ queue, driverId })
    const ttlMs = durationToMs('ttlSeconds', ttlSeconds, { positive: true })
    await this.db.batch('driver-heartbeat', [
      {
        sql: `WITH beat AS (
                INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
                SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?
                WHERE ${epochAdditionFits(NOW_MS, '?')}
                ON CONFLICT (queue, driver_id) DO UPDATE SET
                  last_beat_ms = excluded.last_beat_ms,
                  expires_at_ms = excluded.expires_at_ms
                RETURNING last_beat_ms
              )
              DELETE FROM drivers d USING beat
              WHERE d.expires_at_ms < beat.last_beat_ms
                AND d.last_beat_ms BETWEEN 0 AND ${PERSISTED_INTEGER_BOUNDS.drivers.last_beat_ms.max}
                AND d.expires_at_ms BETWEEN 0 AND ${PERSISTED_INTEGER_BOUNDS.drivers.expires_at_ms.max}`,
        args: [queue, driverId, ttlMs, ttlMs],
      },
    ])
  }

  async retryTask(
    queue: string,
    taskId: string,
  ): Promise<{ runId: string; attempt: number } | null> {
    requireIdentifiersFit({ queue, taskId })
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
         AND NOT ${sagaBegan('tasks')}
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
    requireIdentifiersFit({ queue, taskId })
    const batch = new FencedBatch('cancel-task', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
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
    const deadlineGuard = deadlineOnly ? `${cancelDue('tasks', NOW)} AND ` : ''
    b.casTree(
      'cancel',
      cancelCas({
        queue,
        taskId,
        admission: sqlFragment(
          `${deadlineGuard}${taskOwnsEveryRun('tasks')} AND ${runsLockedBeforeTask('tasks')}`,
        ),
      }),
    )
    b.derived('runs', {
      relation: 'tasks-to-runs',
      fence: 'cancel',
      queue,
      where: 'f.task_id = ?',
      whereArgs: [taskId],
      set: { state: `'cancelled'`, claimed_by: 'NULL', claim_expires_at_ms: 'NULL' },
      // The task is named on the written side too. The source already selects this one
      // task, so it narrows nothing. It gives the planner the key: with the queue bound
      // and only the state beside it, SQLite reaches `runs` through (queue, state) and
      // walks every live run of the queue to cancel one task's.
      narrow: `task_id = ? AND state IN ${LIVE}`,
      narrowArgs: [taskId],
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
    this.taskDone(b, queue, taskId, 'cancel', {
      state: 'cancelled',
      failureReasonJson: REASON_CANCELLED,
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
    return refusedWriteError(operation, runId, this.refusalState(runId))
  }

  /** The rows of the read a batch holds under a name. A name it does not hold is refused, never read as no row. */
  private async rows(b: FencedBatch, name: string): Promise<SqlRow[]> {
    return readRows(b, await b.run(this.db), name)
  }

  /**
   * A refused run's state, read only after its fence refused a write or a heartbeat. The
   * batch is built here and the read is what is returned, because whoever asks reads a
   * failed read as a lost lease: a statement the builder refuses must be thrown as itself,
   * before that catch, and never reported as a lease the worker lost.
   */
  private refusalState(runId: string): () => Promise<unknown> {
    const b = new FencedBatch('refusal-state', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT })
    b.readPrepared('state', REFUSAL_STATE, { runId })
    return async () => (await this.rows(b, 'state'))[0]?.state
  }

  async claimedTaskName(
    queue: string,
    runId: string,
    claimToken: string,
    claimGen: number,
  ): Promise<string | null> {
    requireIdentifiersFit({ queue, runId })
    const validClaimGen = requirePositiveClaimGeneration('claimedTaskName.claimGen', claimGen)
    // The launch carries only ids, so the worker learns the claimed task's name
    // here. The name is immutable, so an unfenced read is safe; the claim
    // conditions only make a stale or already-activated launch read nothing.
    const b = new FencedBatch('claimed-task-name', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT })
    b.readPrepared('name', CLAIMED_TASK_NAME, {
      queue,
      runId,
      claimToken,
      claimGen: validClaimGen,
    })
    const rows = await this.rows(b, 'name')
    const name = rows[0]?.task_name
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
    requireIdentifiersFit({ queue, runId })
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
    finishSuspension(b, queue, runId)
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
    requireIdentifiersFit({ queue, runId })
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
    const b = new FencedBatch('reschedule', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    b.casTree(
      'suspend',
      suspendCas({
        // `reschedule` stays open inside the phase: a build without the task's handler
        // must still be able to park a launch it cannot run.
        phase: 'open',
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
    finishSuspension(b, queue, runId)
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
    requireIdentifiersFit({ queue, runId, 'checkpoint.key': checkpoint?.key })
    requireSagaStepFits('checkpoint.key', checkpoint?.key)
    const relativeWake = wakeHasOwn(wake, 'inSeconds')
    const wakePlan = prepareWake(wake, relativeWake)
    const b = new FencedBatch('suspend', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree(
      'suspend',
      suspendCas({
        // A suspension commits a marker, and the forward phase is frozen once a saga began.
        // The marker is the caller's checkpoint, so its name is checked by the predicates a
        // plain checkpoint write's is. A rollback's name is admitted only inside the phase,
        // where no run suspends, and the engine's own names are refused in either.
        phase: sqlFragment(
          `NOT ${sagaBegan('runs')}
         AND ${checkpointInItsPhase('runs', '?')}
         AND NOT ${checkpointIsTheEngines('?')}`,
          [checkpoint.key, checkpoint.key, checkpoint.key],
        ),
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
    finishSuspension(b, queue, runId)
    const { won } = await b.run(this.db)
    if (won !== 'suspend') throw await this.refusal('suspendRun', runId)
  }

  async complete(
    queue: string,
    runId: string,
    claimToken: string,
    resultJson: string,
  ): Promise<void> {
    requireIdentifiersFit({ queue, runId })
    const taskId = await this.endingTask('complete', queue, runId)
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
    b.followOnTree('task', completeTaskMirror({ runId, queue, resultJson }), 'one')
    waitsGone(b, runId, 'complete')
    this.taskDone(b, queue, taskId, 'task', {
      state: 'completed',
      completedPayloadJson: resultJson,
    })
    const { won } = await b.run(this.db)
    if (won !== 'complete') throw await this.refusal('complete', runId)
    this.runTasks.forget(runId)
  }

  /**
   * The saga arm of a batch that decides a task's failure (DESIGN.md §3.10,
   * specs/Sagas.tla): the rollback pass that carries the saga on, the phase marker when
   * this batch enters the phase, and the task following the pass. Every statement keys
   * on the pass's own stamp, so none fires unless the pass was placed. The pass runs
   * past the user budget, so the task's budget becomes the pass's ordinal, derived from
   * the failed run as `attempts` is. The batch's terminal arm yields to the pass by id.
   */
  private sagaPass(
    b: FencedBatch,
    pass: {
      queue: string
      failedRunId: string
      passId: string
      fence: 'fail' | 'cap'
      /** The failure the task will end with, when this batch enters the phase. */
      enteringWith: string | null
      delayMs: number
      admission: string
      admissionArgs: readonly number[]
    },
  ): void {
    const { queue, failedRunId, passId, fence } = pass
    b.followOnTree(
      'rollback-pass',
      rollbackPassInsert({
        successorId: passId,
        runId: failedRunId,
        delayMs: pass.delayMs,
        fence,
        taskOwnsRun: sqlFragment(runOwnedByTask('f', 't')),
        // The batch writes the task's budget as the failed run's user ordinal plus one, so
        // that sum must be a budget a task may have. The guard reads the ordinal the batch
        // writes from, and never the stored budget, which the batch replaces: a task spawned
        // with the largest budget rolls back like any other. The pass's own ordinal has room
        // too, because every compare-and-set a pass is fenced on vouches for the accounting
        // identity, under which a run's ordinal is its task's attempts and infrastructure
        // retries plus one.
        admission: sqlFragment(
          `t.state IN ${LIVE} AND ${pass.admission}
           AND (f.attempt - t.infra_retries) < ${TASK_INTEGER_BOUNDS.max_attempts.max}`,
          [...pass.admissionArgs],
        ),
        successorFree: sqlFragment(`NOT ${successorOwned('?', 'f.task_id', 'f.attempt + 1')}`, [
          passId,
        ]),
      }),
      'one',
    )
    if (pass.enteringWith !== null) {
      b.followOnTree(
        'rolling-back',
        checkpointWrite({
          runId: passId,
          checkpointName: SAGA_PHASE_CHECKPOINT,
          stateJson: pass.enteringWith,
          fence: 'rollback-pass',
          attemptStored: sqlFragment(storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'f')),
        }),
        'one',
      )
    }
    b.derived('task-rolling-back', {
      relation: 'runs-to-tasks',
      // Bound, not correlated: a source that names the target's queue is evaluated once
      // for every task row, and the update then walks the table to find one task.
      queue,
      fence: 'rollback-pass',
      where: 'f.run_id = ?',
      whereArgs: [passId],
      set: {
        attempts: USER_ATTEMPTS_FROM('?', b.fence(fence)),
        max_attempts: `${USER_ATTEMPTS_FROM('?', b.fence(fence))} + 1`,
        state: stampedRunState(passId, 'rollback-pass'),
        last_attempt_run: '?',
      },
      setArgs: [failedRunId, failedRunId, passId],
      narrow: `state IN ${LIVE}`,
      rows: 'one',
    })
  }

  /**
   * User-code failure. Retry POLICY is decided by the caller (core's
   * decideRetry over the user ordinal); the store applies the fenced
   * transition. tasks.attempts moves here (the TLC-checked AttemptAccounting
   * shape) and wherever a rollback pass is placed, which is `sagaPass`, from a
   * failure or from a sweep's cap arm. Both derive it from the failed run's own
   * ordinal. A retrying failure inserts the successor run
   * (attempt+1, carrying SUCCESSOR_CARRIED_RUN_COLUMNS) in the same batch.
   */
  async fail(
    queue: string,
    runId: string,
    claimToken: string,
    failureJson: string,
    retry: { delaySeconds: number } | null,
  ): Promise<FailOutcome> {
    requireIdentifiersFit({ queue, runId })
    const successorId = retry ? this.ids.uuidv7() : null
    const passId = successorId ?? this.ids.uuidv7()
    const retryDelayMs = retry ? durationToMs('retry.delaySeconds', retry.delaySeconds) : null
    const taskId = await this.endingTask('fail', queue, runId)
    const b = new FencedBatch('fail', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT })
    return this.failInto(b, {
      operation: 'fail',
      queue,
      runId,
      claimToken,
      failureJson,
      taskId,
      successorId,
      retryDelayMs,
      passId,
    })
  }

  /**
   * A failed rollback of a task that is rolling back (DESIGN.md §3.10, specs/Sagas.tla
   * RollbackRetry and RollbackHalts). The batch is `fail`'s with no user retry: the
   * attempt record lands behind the failure itself, and then either another pass
   * follows, which the user budget does not cap, or the task ends where it stands.
   */
  async failRollback(
    queue: string,
    runId: string,
    claimToken: string,
    failureJson: string,
    retry: { delaySeconds: number } | null,
    rollback: FailedRollback,
  ): Promise<FailOutcome> {
    const failed = requireFailedRollback(rollback)
    requireIdentifiersFit({ queue, runId })
    const passId = this.ids.uuidv7()
    const passDelayMs =
      retry === null ? null : durationToMs('retry.delaySeconds', retry.delaySeconds)
    const taskId = await this.endingTask('failRollback', queue, runId)
    // The store names the attempt record and counts the attempt, one past the last one
    // stored, which core reads here and the claim's fence keeps current (DESIGN.md §3.10).
    const tried = await failedRollbackRecord(
      {
        open: () =>
          new FencedBatch('rollback-tries', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        run: (batch: FencedBatch) => batch.run(this.db),
      },
      taskId,
      failed,
    )
    const b = new FencedBatch('fail-rollback', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    return this.failInto(b, {
      operation: 'failRollback',
      queue,
      runId,
      claimToken,
      failureJson,
      taskId,
      successorId: null,
      retryDelayMs: null,
      passId,
      rollback: { tried, passDelayMs },
    })
  }

  /**
   * The failure batch, which `fail` and `failRollback` each run under their own label.
   * `successorId` and `retryDelayMs` are the user retry's, and `rollback` is the failed
   * rollback's attempt record with the delay of the pass that retries it.
   */
  private async failInto(
    b: FencedBatch,
    failure: {
      operation: 'fail' | 'failRollback'
      queue: string
      runId: string
      claimToken: string
      failureJson: string
      taskId: string
      successorId: string | null
      retryDelayMs: number | null
      passId: string
      rollback?: { tried: CheckpointWrite; passDelayMs: number | null }
    },
  ): Promise<FailOutcome> {
    const { queue, runId, claimToken, failureJson, taskId, successorId, retryDelayMs, passId } =
      failure
    const { rollback } = failure
    const retry = retryDelayMs !== null
    const retryDeadlineGuard =
      retryDelayMs === null
        ? ''
        : `AND ((runs.attempt - t.infra_retries) >= t.max_attempts
          OR ${epochAdditionFits(NOW, '?')})`
    b.casTree(
      'fail',
      failCas({
        // A failed rollback is one only while its task is rolling back. Every statement
        // behind this one is fenced on its stamp, so none of them asks again.
        phase: rollback === undefined ? 'open' : sqlFragment(sagaBegan('runs')),
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
    // The saga arms (DESIGN.md §3.10, specs/Sagas.tla). Outside the phase, a failure no
    // retry follows is the task's terminal decision. When a registered step started and
    // is not rolled back, this batch enters the phase in place of ending the task. A
    // retry the user budget refuses is that same decision. Inside the phase the entry
    // hands over the failed rollback's attempt record, which the store named and counted
    // and which lands behind the failure itself, so a failed attempt is counted or the
    // pass did not fail. A retry there is
    // a pass the user budget does not cap, and a failure without the record is capped
    // like any other, which halts the saga.
    if (rollback !== undefined) {
      b.followOnTree(
        'rollback-tried',
        checkpointWrite({
          runId,
          checkpointName: rollback.tried.key,
          stateJson: rollback.tried.stateJson,
          fence: 'fail',
          attemptStored: sqlFragment(storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'f')),
        }),
        'one',
      )
    }
    if (rollback === undefined) {
      const budgetSpent = retry ? ' AND (f.attempt - t.infra_retries) >= t.max_attempts' : ''
      this.sagaPass(b, {
        queue,
        failedRunId: runId,
        passId,
        fence: 'fail',
        enteringWith: failureJson,
        delayMs: 0,
        admission: `NOT ${sagaBegan('t')} AND ${rollbackPending('t')}${budgetSpent}`,
        admissionArgs: [],
      })
    } else if (rollback.passDelayMs !== null) {
      this.sagaPass(b, {
        queue,
        failedRunId: runId,
        passId,
        fence: 'fail',
        enteringWith: null,
        delayMs: rollback.passDelayMs,
        admission: epochAdditionFits('f.fence_at_ms', '?'),
        admissionArgs: [rollback.passDelayMs],
      })
    }
    if (retry && successorId && retryDelayMs !== null) {
      // Only a LIVE task with user budget remaining gets a retry run. The cap
      // is expressed with the SAME user-ordinal definition the counter uses
      // (`run.attempt - infra_retries`) rather than `attempts + 1`: two
      // spellings of one quantity is how a stored counter that has drifted
      // one ahead — from the historical blind-increment bug — refuses the
      // last configured attempt while the accounting band still calls the
      // state legal. The delay runs from the failure's own instant.
      b.followOnTree(
        'successor',
        userRetrySuccessorInsert({
          successorId,
          runId,
          delayMs: retryDelayMs,
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
      // once — an exact replay cannot double-count.
      b.derived('task-retrying', {
        relation: 'runs-to-tasks',
        fence: 'successor',
        queue,
        where: 'f.run_id = ?',
        whereArgs: [successorId],
        set: {
          attempts: USER_ATTEMPTS_FROM('?', b.fence('fail')),
          state: stampedRunState(successorId, 'successor'),
          last_attempt_run: '?',
        },
        setArgs: [runId, successorId],
        narrow: `state IN ${LIVE}`,
        rows: 'one',
      })
      // Cap refused (or task no longer live): terminal, same as no-retry.
      b.derived('task-terminal', {
        relation: 'runs-to-tasks',
        fence: 'fail',
        queue,
        where: 'f.run_id = ?',
        whereArgs: [runId],
        set: {
          attempts: USER_ATTEMPTS_FROM('?', b.fence('fail')),
          state: taskStateValue('failed'),
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
        queue,
        where: 'f.run_id = ?',
        whereArgs: [runId],
        set: {
          attempts: USER_ATTEMPTS_FROM('?', b.fence('fail')),
          state: taskStateValue('failed'),
          failure_reason: '?',
        },
        setArgs: [runId, failureJson],
        // Terminal only when this batch placed no rollback pass.
        narrow: `state IN ${LIVE}
            AND NOT ${successorOwned(
              '?',
              'tasks.task_id',
              '(SELECT p.attempt + 1 FROM runs p WHERE p.run_id = ?)',
            )}`,
        narrowArgs: [passId, runId],
        rows: 'one',
      })
    }
    waitsGone(b, runId, 'fail')
    // The task turns terminal under one of two statements, and only the one that ran
    // stamped it, so the event follows whichever ended the task and no retry writes one.
    this.taskDone(b, queue, taskId, retry ? 'task-terminal' : 'task', {
      state: 'failed',
      failureReasonJson: failureJson,
    })
    const { won, results } = await b.run(this.db)
    if (won !== 'fail') throw await this.refusal(failure.operation, runId)
    this.runTasks.forget(runId)
    return { rollingBack: (results['task-rolling-back']?.rowsAffected ?? 0) === 1 }
  }

  async getCheckpoints(queue: string, taskId: string, attempt: number): Promise<Checkpoint[]> {
    requireIdentifiersFit({ queue, taskId })
    const visibleThrough = requireRunOrdinal('getCheckpoints.attempt', attempt)
    const b = new FencedBatch('get-checkpoints', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT })
    b.readPrepared('checkpoints', CHECKPOINTS, { queue, taskId, visibleThrough })
    const rows = await this.rows(b, 'checkpoints')
    return rows.map((row) => ({
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
    requireIdentifiersFit({ queue, taskId, runId, checkpointName })
    requireSagaStepFits('checkpointName', checkpointName)
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
        // The forward phase is frozen once a saga began, and a rollback runs only in it.
        sagaPhase: sqlFragment(
          `${checkpointInItsPhase('runs', '?')}
         AND NOT ${checkpointIsTheEngines('?')}`,
          [checkpointName, checkpointName, checkpointName],
        ),
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
    requireIdentifiersFit({ queue, taskId })
    const b = new FencedBatch('task-result', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT })
    b.readPrepared('result', TASK_RESULT, { queue, taskId })
    const rows = await this.rows(b, 'result')
    const row = rows[0]
    if (row === undefined) return null
    const result = decodeTaskResult(taskId, row)
    const rollback = decodeRollbackOutcome(taskId, row)
    return rollback === undefined ? result : { ...result, rollback }
  }

  async nextWakeAtEpochMs(queue: string): Promise<number | null> {
    requireIdentifiersFit({ queue })
    const b = new FencedBatch('next-wake', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT })
    b.readPrepared('wake', NEXT_WAKE, { queue })
    const rows = await this.rows(b, 'wake')
    const value = rows[0]?.wake_ms
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
    requireIdentifiersFit({ queue, eventName })
    const name = EventName.fromPort('emitEvent', eventName)
    if (typeof payloadJson !== 'string') {
      throw new RangeError('emitEvent payloadJson must be a string')
    }
    const b = new FencedBatch('emit-event', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
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
        eventName: name,
        payloadJson,
        existingEventAdmits: sqlFragment(
          `events.payload IS NOT NULL
         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`,
        ),
      }),
    )
    this.wakeWaiters(b, queue, name, 'waits-gone')
    b.openTailTree(
      'stored-event',
      'a replay may read an event stamped by the earlier delivery, but its immutable payload must still be TEXT',
      storedEventRead({
        queue,
        eventName: name,
        payloadType: sqlFragment(STORED_PAYLOAD_TYPE),
      }),
    )
    const { results } = await b.run(this.db)
    const stored = results['stored-event']?.rows[0]
    if (stored?.payload_type !== 'text') {
      throw new RangeError(`emitEvent ${queue}/${name.display} found a non-TEXT stored payload`)
    }
  }

  /**
   * What this dialect supplies to core's side of a task's ending and of a child await,
   * built on first use: a worker's own terminal write finds its task in the memo and
   * needs none of it.
   */
  private taskDoneDialect(): TaskDoneDialect {
    this.taskDoneFacts ??= {
      run: (batch: FencedBatch) => batch.run(this.db),
      open: {
        runTask: () => new FencedBatch('run-task', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        taskDoneState: () =>
          new FencedBatch('task-done-state', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        recordTaskDone: () =>
          new FencedBatch('record-task-done', this.ids.token(), {
            now: NOW_MS,
            tree: TREE_DIALECT,
          }),
      },
      awaitNamedEvent: (awaited, name) =>
        this.awaitNamedEvent(
          awaited.queue,
          awaited.taskId,
          awaited.runId,
          awaited.claimToken,
          awaited.stepName,
          name,
          awaited.timeoutSeconds,
        ),
      refusal: (operation, runId) => this.refusal(operation, runId),
      taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
      liveTask: sqlFragment(`t.state IN ${LIVE}`),
      storedPayloadType: sqlFragment(STORED_PAYLOAD_TYPE),
    }
    return this.taskDoneFacts
  }

  /** A run's task, before the batch that ends the run: core's read, behind this store's memo. */
  private endingTask(operation: string, queue: string, runId: string): Promise<string> {
    return endingTask(this.taskDoneDialect(), this.runTasks, operation, queue, runId)
  }

  /**
   * What every terminal batch owes a task's parent, added through core (`addTaskDone`):
   * the completion event and the wake of every run parked on it.
   */
  private taskDone(
    b: FencedBatch,
    queue: string,
    taskId: string,
    terminal: string,
    outcome: TaskOutcome,
  ): void {
    addTaskDone(
      b,
      { queue, taskId, terminal, outcome },
      {
        wake: (name) => this.wakeWaiters(b, queue, name, 'woken-waits-gone'),
      },
    )
  }

  /**
   * Wake every run parked on the event this batch recorded under the statement named
   * `event`: `emit-event`'s compare-and-set, or a terminal batch's completion event.
   * A terminal batch already has a `waits-gone`, for the waits of the run it ends, so
   * the caller names the statement that reaps the woken runs' waits.
   */
  private wakeWaiters(b: FencedBatch, queue: string, name: EventName, waitsGone: string): void {
    const eventName = name.value
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
    b.followOnTree(
      'wake-runs',
      wakeRunsUpdate({
        eventName: name,
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
      // The source is the runs this batch woke, and the stamp says which those are. The
      // stamp has no index, so the access path is what wake-runs just set on exactly
      // these rows: `wake_event`, and `state = 'pending'`. The partial index `runs_woken`
      // holds only runs that were woken and not yet claimed, so this reads a handful of
      // rows. By queue and state alone the only index is `runs_poll`, and every batch
      // that ends a task would walk every pending run of its queue, three times. The
      // queue is bound on both sides and not correlated, or the source would run once
      // for every task row.
      queue,
      where: `f.wake_event = ? AND f.state = 'pending'`,
      whereArgs: [eventName],
      set: { state: taskStateValue('pending') },
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
    // `wake-runs` just stamped, so the primitive builds the selection. No
    // follow-on of this batch is hand-written text: the wake is a shared statement.
    b.derived(waitsGone, {
      relation: 'runs-to-waits',
      fence: 'wake-runs',
      // Same reason as wake-tasks: the queue narrows the source to an index,
      // and `state = 'pending'` is what wake-runs just set on these rows.
      where: `f.queue = ? AND f.wake_event = ? AND f.state = 'pending'`,
      whereArgs: [queue, eventName],
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
      where: `f.queue = ? AND f.wake_event = ? AND f.state = 'pending'`,
      whereArgs: [queue, eventName],
      rows: 'source-keys',
    })
  }

  async awaitEvent(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    eventName: string,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false }> {
    requireIdentifiersFit({ queue, taskId, runId, stepName, eventName })
    const answer = await this.awaitNamedEvent(
      queue,
      taskId,
      runId,
      claimToken,
      stepName,
      EventName.fromPort('awaitEvent', eventName),
      timeoutSeconds,
    )
    if (answer === null) throw await this.refusal('awaitEvent', runId)
    return answer
  }

  /** The child await (DESIGN.md §3.2). The protocol is core's `awaitTaskDone`, and this dialect supplies its facts. */
  async awaitTaskDone(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    childTaskId: string,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false }> {
    requireIdentifiersFit({ queue, taskId, runId, stepName })
    return awaitTaskDone(this.taskDoneDialect(), {
      queue,
      taskId,
      runId,
      claimToken,
      stepName,
      childTaskId,
      timeoutSeconds,
    })
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
  private async awaitNamedEvent(
    queue: string,
    taskId: string,
    runId: string,
    claimToken: string,
    stepName: string,
    name: EventName,
    timeoutSeconds: number | null,
  ): Promise<{ emitted: true; payloadJson: string } | { emitted: false } | null> {
    const eventName = name.value
    const timeoutMs =
      timeoutSeconds === null
        ? null
        : durationToMs('timeoutSeconds', timeoutSeconds, { positive: true })
    const b = new FencedBatch('await-event', this.ids.token(), {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
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
    b.casTree(
      'register',
      registerWaitCas({
        queue,
        runId,
        taskId,
        claimToken,
        stepName,
        eventName: name,
        timeoutAt: sqlFragment(
          `CASE WHEN CAST(? AS BIGINT) IS NOT NULL THEN ${NOW} + ? ELSE NULL END`,
          [timeoutMs, timeoutMs],
        ),
        timeoutFits: sqlFragment(`CAST(? AS BIGINT) IS NULL OR ${epochAdditionFits(NOW, '?')}`, [
          timeoutMs,
          timeoutMs,
        ]),
        taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
        taskEligible: sqlFragment(eligibleTask('t', NOW)),
        phase: sqlFragment(`NOT ${sagaBeganOf('?')}`, [taskId]),
      }),
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
      queue,
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
      // The run is named on the written side too. The source already selects this one
      // run, so it narrows nothing, and it gives the planner the key: beside a queue
      // and a state, SQLite prefers (queue, state) and walks the queue's running runs.
      narrow: `run_id = ? AND queue = ? AND task_id = ? AND claimed_by = ? AND state = 'running'
            AND EXISTS (SELECT 1 FROM tasks t
                        WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,
      narrowArgs: [runId, queue, taskId, claimToken],
      rows: 'one',
    })
    b.derived('task-mirror', {
      relation: 'runs-to-tasks',
      fence: 'park',
      queue,
      where: `f.run_id = ? AND f.state = 'sleeping'`,
      whereArgs: [runId],
      set: { state: taskStateValue('sleeping') },
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
        eventName: name,
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
        // A child await reaches the task's code, which never sees the engine's event name.
        const operation = name.taskId === null ? 'awaitEvent' : 'awaitTaskDone'
        throw new RangeError(
          `${operation} ${queue}/${name.display} found a non-TEXT stored payload`,
        )
      }
      return { emitted: true, payloadJson: String(row.payload) }
    }
    // Nothing registered and nothing emitted. The caller says why: for a user event it
    // is this run's claim, and a child await reads the child first.
    if (won !== 'register') return null
    return { emitted: false }
  }
}

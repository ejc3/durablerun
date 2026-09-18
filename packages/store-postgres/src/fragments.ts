import {
  MAX_DURATION_MS,
  MAX_EPOCH_MS,
  PERSISTED_INTEGER_BOUNDS,
  POSITIVE_CLAIM_GENERATION_BOUNDS,
  type PersistedIntegerBounds,
  type PersistedIntegerBoundsExceptClaimGeneration,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
} from '@durablerun/core'

/**
 * Shared SQL fragments — the ONLY place engine SQL may say what "live",
 * "cancellation due", "eligible to proceed", or "written by this batch" mean.
 * Every door (claim, activate, sweep, cancel) composes these; none re-derives
 * them.
 *
 * Why this file exists: the claim once re-derived task eligibility without the
 * cancellation-deadline predicate, so a task past its deadline could be
 * claimed and launched whenever the sweep budget ran out before cancelling it.
 * A predicate defined once cannot drift; a lint (scripts/fragment-lint.py)
 * fails any store SQL that writes an eligibility comparison or a raw state
 * list outside this file.
 */

/** Non-terminal states — tasks and runs still in play. */
export const LIVE = `('pending','running','sleeping')`

/** The states a freshly created successor run can be in: waiting for its turn. */
export const QUEUED = `('pending','sleeping')`

/**
 * The instant a given statement of THIS batch recorded on the row identified by
 * `key`. A follow-on cannot read the clock (§3.4 rule 8), so when it needs an
 * instant it takes the one the fenced row already carries. The subquery returns
 * no row unless that statement's stamp is on the row, so it is also the proof
 * that the batch wrote it. `key` is the correlation, written against the alias
 * `f`. The EXISTS form of this proof and the stamp-and-instant pair that
 * hand-written follow-ons used are gone: every follow-on is a statement tree
 * now, and the tree rules hold its gate and its provenance.
 */
export const fencedAt = (table: string, key: string, fence: string): string =>
  `(SELECT f.fence_at_ms FROM ${table} f WHERE ${key} AND f.fence_stamp = ${fence})`

/**
 * A scalar owned only when its source predicate identifies exactly one row.
 *
 * Remote Turso rejects aggregate HAVING without GROUP BY even though local
 * libSQL accepts it. The caller supplies a key that its predicate equality-
 * fixes to one value, so both projections use one portable grouped aggregate.
 * One builder prevents singleton projections from drifting back to the
 * local-only spelling.
 */
export const singletonAggregate = (
  value: string,
  source: string,
  where: string,
  fixedGroupKey: string,
): { value: string; atMostOne: string } => ({
  value: `(SELECT MIN(${value})
           FROM ${source}
           WHERE ${where}
           GROUP BY ${fixedGroupKey}
            HAVING COUNT(*) = 1)`,
  atMostOne: `NOT EXISTS (SELECT 1 FROM ${source}
                          WHERE ${where}
                          GROUP BY ${fixedGroupKey}
                              HAVING COUNT(*) > 1)`,
})

/**
 * The exact wait registration owned by a parked run.
 *
 * `wake_step` did not exist until schema v3, but waits always carried the step.
 * Every transition that consumes a legacy registration first copies that
 * immutable identity into the run. Keeping the full witness here means claim
 * and emit cannot recover a step from different or partial registrations. A
 * legacy run may match several old rows, and without an active-wait id there
 * is no truthful way to choose among them, so the scalar exists only when the
 * full witness identifies exactly one registration.
 */
export const registeredWait = (
  run: string,
): { step: string; current: string; unambiguous: string; temporallySafe: string } => {
  const witness = `w.run_id = ${run}.run_id
      AND w.queue = ${run}.queue
      AND w.task_id = ${run}.task_id
      AND w.event_name = ${run}.wake_event
      AND w.status = 'waiting'
      AND w.timeout_at_ms IS NOT DISTINCT FROM ${run}.available_at_ms
      AND (${run}.available_at_ms IS NULL
        OR ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.runs.available_at_ms, run)})
      AND (w.timeout_at_ms IS NULL
        OR ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.waits.timeout_at_ms, 'w')})`
  const registration = singletonAggregate('w.step_name', 'waits w', witness, 'w.run_id')
  return {
    step: registration.value,
    current: `EXISTS (SELECT 1 FROM waits w
                      WHERE ${witness}
                        AND w.step_name = ${run}.wake_step)`,
    // Zero matches can mean there is no active event wait (a successor may
    // legitimately carry historical wake fields). More than one is the
    // unsafe state: no caller may consume it by guessing a step.
    unambiguous: registration.atMostOne,
    temporallySafe: `NOT EXISTS (
      SELECT 1 FROM waits w
      WHERE w.run_id = ${run}.run_id AND w.status = 'waiting'
        AND w.timeout_at_ms IS NOT NULL
        AND NOT ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.waits.timeout_at_ms, 'w')}
    )`,
  }
}

/**
 * Successor identity, keyed on immutable ownership rather than on a fence.
 *
 * A fence proves a row carries a stamp right now. That is not the same as
 * proving this batch wrote it, and the difference is not academic: claiming a
 * run is itself a transition that re-stamps it, so a few seconds after a
 * failure created a successor, the successor no longer carries the failure's
 * stamp. A discriminator built on the stamp therefore answers "no successor"
 * about a successor that exists and is running — and the failure's terminal
 * arm kills a task whose retry is live under a worker, or its insert runs
 * again and dies on the unique (task_id, attempt) index, discarding a whole
 * tick. Ownership does not decay, so this asks about that instead.
 *
 * A run id and task id are not enough to identify the intended successor: an
 * id source can collide with a historical run of the same task. The attempt is
 * the third immutable component. Requiring all three in this primitive makes a
 * call site unable to classify either the parent or a historical attempt as a
 * replay of the successor; the insert proceeds and fails on the primary key,
 * loudly.
 *
 * Misclassifying any older attempt makes the insert and every follow-on write
 * nothing, committing a HALF-transition: a failed run under a task still
 * marked running. A collision with a foreign row already fails loudly, and an
 * id-generation failure against any run of our own task is no less a failure.
 */
export const successorOwned = (id: string, task: string, attempt: string): string =>
  `EXISTS (SELECT 1 FROM runs s
           WHERE s.run_id = ${id} AND s.task_id = ${task}
             AND s.attempt = ${attempt})`

/**
 * A cancellation deadline that has already passed, as of `at`.
 *
 * `at` is explicit at every call site and has no default: which instant a
 * comparison uses is precisely the thing that goes wrong. A compare-and-set
 * passes the batch's clock; a follow-on passes the fence_at_ms its CAS
 * recorded, because a follow-on re-reading the clock can disagree with the
 * CAS that admitted it and undo the transition it was supposed to complete.
 */
export const cancelDue = (task: string, at: string): string => {
  const column = `${task}.cancel_at_ms`
  return `(${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.tasks.cancel_at_ms, task)}
    AND ${column} <= ${at})`
}

/** No cancellation deadline, or one still in the future as of `at`. */
export const cancelNotDue = (task: string, at: string): string => {
  const column = `${task}.cancel_at_ms`
  return `(${column} IS NULL
    OR (${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.tasks.cancel_at_ms, task)}
      AND ${column} > ${at}))`
}

/**
 * PostgreSQL's BIGINT columns reject fractional and non-numeric values at the
 * storage boundary. A non-null check therefore is the native exact-integer
 * proof; the semantic bounds remain explicit below.
 */
export const storedInteger = (col: string): string => `(${col}) IS NOT NULL`

/** Native INTEGER plus the semantic port range used before durable arithmetic. */
const storedBoundedInteger = (col: string, min: number, max: number): string =>
  `(${storedInteger(col)} AND ${col} BETWEEN ${min} AND ${max})`

const persistedColumn = (bounds: PersistedIntegerBounds, alias?: string): string => {
  const separator = bounds.field.indexOf('.')
  if (separator < 0 || separator === bounds.field.length - 1) {
    throw new Error(`persisted integer field must be table-qualified, got ${bounds.field}`)
  }
  const column = bounds.field.slice(separator + 1)
  return alias === undefined ? column : `${alias}.${column}`
}

/**
 * A persisted field checked against its one canonical semantic bound.
 *
 * The durable field and its semantic interval are one runtime descriptor.
 * Callers may choose only a SQL alias; there is no independently selected
 * column that can drift from the bounds, even through a union type.
 */
export const storedIntegerWithin = (
  bounds: PersistedIntegerBoundsExceptClaimGeneration,
  alias?: string,
): string => {
  const column = persistedColumn(bounds, alias)
  return storedBoundedInteger(column, bounds.min, bounds.max)
}

/**
 * A persisted integer that is safe to increment once without leaving its
 * semantic field range. The guard describes the RESULT of the arithmetic, not
 * merely the source representation.
 */
export const storedIncrementableInteger = (
  bounds: PersistedIntegerBoundsExceptClaimGeneration,
  alias?: string,
): string => {
  const column = persistedColumn(bounds, alias)
  return storedBoundedInteger(column, bounds.min, bounds.max - 1)
}

/**
 * One database instant plus one or more already-validated relative durations.
 *
 * The base must itself be an exact epoch integer. Callers supply deltas that
 * their own port/stored-field guards have already constrained to nonnegative
 * durations; subtraction proves headroom before the write performs the
 * addition. Each delta occurs exactly once so an anonymous SQL placeholder
 * still consumes exactly one argument.
 */
export const epochAdditionFits = (base: string, ...deltas: readonly string[]): string => {
  if (deltas.length === 0) throw new Error('epochAdditionFits requires at least one delta')
  const totalDelta = deltas.map((delta) => `CAST((${delta}) AS BIGINT)`).join(' + ')
  return `(${storedInteger(base)}
    AND (${base}) BETWEEN 0 AND ${MAX_EPOCH_MS}
    AND (${base}) <= ${MAX_EPOCH_MS} - (${totalDelta}))`
}

/** A due run availability, including its exact persisted field contract. */
export const runAvailableDue = (run: string, at: string): string => {
  const column = `${run}.available_at_ms`
  return `(${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.runs.available_at_ms, run)}
    AND ${column} <= ${at})`
}

/** An expired claim, including its exact persisted field contract. */
export const runClaimExpired = (run: string, at: string): string => {
  const column = `${run}.claim_expires_at_ms`
  return `(${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.runs.claim_expires_at_ms, run)}
    AND ${column} <= ${at})`
}

/** A claim expiry strictly after `at`, including its exact field contract. */
export const runClaimUnexpired = (run: string, at: string): string => {
  const column = `${run}.claim_expires_at_ms`
  return `(${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.runs.claim_expires_at_ms, run)}
    AND ${column} > ${at})`
}

/** A returned/consumed claim generation is always strictly positive. */
export const storedPositiveClaimGeneration = (alias?: string): string => {
  const bounds = POSITIVE_CLAIM_GENERATION_BOUNDS
  const column = persistedColumn(bounds, alias)
  return storedBoundedInteger(column, bounds.min, bounds.max)
}

/** A claim candidate's generation must have room for the claim CAS bump. */
export const storedIncrementableClaimGeneration = (alias?: string): string => {
  const bounds = PERSISTED_INTEGER_BOUNDS.runs.claim_gen
  const column = persistedColumn(bounds, alias)
  return storedBoundedInteger(column, bounds.min, bounds.max - 1)
}

/**
 * The accounting relation of the current live run.
 *
 * Every transition that derives a successor ordinal or a task counter composes
 * this one fragment before writing. That makes subtraction underflow and
 * out-of-contract successor ordinals unreachable from a corrupt stored row.
 */
export const storedCurrentRunAccounting = (run: string, task: string): string => {
  const taskBounds = PERSISTED_INTEGER_BOUNDS.tasks
  const runBounds = PERSISTED_INTEGER_BOUNDS.runs
  return `(${storedIntegerWithin(runBounds.attempt, run)}
    AND ${storedIntegerWithin(taskBounds.attempts, task)}
    AND ${storedIntegerWithin(taskBounds.max_attempts, task)}
    AND ${storedIntegerWithin(taskBounds.infra_retries, task)}
    AND ${task}.attempts < ${task}.max_attempts
    AND ${run}.attempt = ${task}.attempts + ${task}.infra_retries + 1)`
}

/**
 * A current run is the highest valid owned ordinal for its task.
 *
 * Refuse both a higher historical run and any sibling whose ordinal has an
 * invalid representation/range. Consumers must not let backend comparison
 * coercion decide which corrupted run is current.
 */
export const storedHighestOwnedOrdinal = (run: string): string => {
  const attempt = PERSISTED_INTEGER_BOUNDS.runs.attempt
  return `NOT EXISTS (
    SELECT 1 FROM runs higher
    WHERE higher.task_id = ${run}.task_id
      AND (NOT ${storedIntegerWithin(attempt, 'higher')}
        OR higher.attempt > ${run}.attempt)
  )`
}

/**
 * A task eligible to make forward progress (be claimed, be activated): still
 * live AND not past a due cancellation deadline. `t` is the alias of the tasks
 * table in the calling query.
 */
export const eligibleTask = (t: string, at: string): string =>
  `${t}.state IN ${LIVE} AND ${cancelNotDue(t, at)}`

/** A run belongs to a task only when both immutable ownership fields agree. */
export const runOwnedByTask = (run: string, task: string): string =>
  `${task}.task_id = ${run}.task_id AND ${task}.queue = ${run}.queue`

/**
 * Lock a task's live runs before the task's own row, inside the statement that updates
 * the task. Every worker write, every sweep, and the wake of a parked run lock the run
 * and then the task that mirrors it. A cancellation updates the task first, and two
 * transactions that take the same two rows in opposite orders deadlock. PostgreSQL
 * evaluates a statement's predicates before it locks the row they admit, so this
 * predicate, which is always true, takes the run locks first and gives the
 * cancellation the order everything else has. Only live runs are locked: nothing that
 * writes a task also writes a run of it that has ended. SQLite has one writer and
 * needs none.
 */
export const runsLockedBeforeTask = (task: string): string =>
  `(SELECT COUNT(*) FROM (
      SELECT 1 FROM runs lock_order_run
      WHERE lock_order_run.task_id = ${task}.task_id
        AND lock_order_run.state IN ${LIVE}
      ORDER BY lock_order_run.run_id
      FOR UPDATE
    ) locked_runs) >= 0`

/** A task transition must not strand or consume a run from another queue. */
export const taskOwnsEveryRun = (task: string): string =>
  `NOT EXISTS (
    SELECT 1 FROM runs ownership_run
    WHERE ownership_run.task_id = ${task}.task_id
      AND ownership_run.queue <> ${task}.queue
  )`

/**
 * Prove a TEXT value can enter jsonb before any jsonb cast or operator sees it.
 * PostgreSQL's IS JSON accepts numbers outside jsonb/numeric range and Unicode
 * escapes jsonb cannot represent; pg_input_is_valid reports those conversion
 * failures as false instead of aborting the transaction.
 */
export const jsonbInputValid = (value: string): string => `pg_input_is_valid(${value}, 'jsonb')`

/** Durable retry JSON that can be decoded into a worker payload. */
export const durableTaskRetryAdmissible = (task: string): string => {
  const retry = `${task}.retry_strategy`
  const kind = `(${retry}::jsonb ->> 'kind')`
  const duration = (key: string): string => {
    const value = `((${retry}::jsonb ->> '${key}')::numeric)`
    return `(CASE
      WHEN jsonb_typeof(${retry}::jsonb -> '${key}') <> 'number' THEN FALSE
      WHEN ${value} < 0 OR ${value} > ${MAX_DURATION_MS} THEN FALSE
      ELSE ROUND(${value} * 1000) BETWEEN 0 AND ${MAX_DURATION_MS}
    END)`
  }
  const factor = `((${retry}::jsonb ->> 'factor')::numeric)`
  const factorAdmissible = `(CASE
      WHEN jsonb_typeof(${retry}::jsonb -> 'factor') <> 'number' THEN FALSE
      ELSE ${factor} BETWEEN 0 AND 1.7976931348623157e308
    END)`
  return `(
    CASE
      WHEN NOT ${jsonbInputValid(retry)} THEN 0
      WHEN NOT (${retry} IS JSON OBJECT WITH UNIQUE KEYS) THEN 0
      WHEN jsonb_typeof(${retry}::jsonb -> 'kind') <> 'string' THEN 0
      WHEN (${kind}) = 'none' THEN 1
      WHEN (${kind}) = 'fixed' THEN CASE WHEN ${duration('baseSeconds')} THEN 1 ELSE 0 END
      WHEN (${kind}) = 'exponential' THEN CASE
        WHEN ${duration('baseSeconds')}
          AND ${factorAdmissible}
          AND ${duration('maxSeconds')}
        THEN 1 ELSE 0 END
      ELSE 0
    END = 1
  )`
}

/** Durable header JSON that can be decoded into a worker payload. */
export const durableTaskHeadersAdmissible = (task: string): string => {
  const headers = `${task}.headers`
  return `(
    CASE
      WHEN ${headers} IS NULL THEN 1
      WHEN NOT ${jsonbInputValid(headers)} THEN 0
      WHEN NOT (${headers} IS JSON OBJECT WITH UNIQUE KEYS) THEN 0
      WHEN EXISTS (
        SELECT 1 FROM jsonb_each(${headers}::jsonb) h
        WHERE jsonb_typeof(h.value) <> 'string'
      ) THEN 0
      ELSE 1
    END = 1
  )`
}

/**
 * A claim candidate is the task's only live run.
 *
 * Multiple live runs are storage corruption, not extra claimable work. If a
 * claim advances both, one task can be launched twice and its run-to-task
 * follow-on has two competing sources. Refusing every sibling-bearing
 * candidate keeps the corrupt task inert at the first forward-progress door.
 */
export const soleLiveRun = (run: string): string =>
  `NOT EXISTS (SELECT 1 FROM runs sibling
               WHERE sibling.task_id = ${run}.task_id
                 AND sibling.state IN ${LIVE}
                 AND sibling.run_id <> ${run}.run_id)`

/**
 * A saga's durable state is checkpoints under reserved names (core `sagas.ts`,
 * DESIGN.md §3.10). `task` is any alias that carries a `task_id`: a task, or a run.
 * The phase marker is written in the batch that decides the task's terminal failure.
 */
export const sagaBegan = (task: string): string => sagaBeganOf(`${task}.task_id`)

/** `sagaBegan` for a task named by an expression, such as a bound id. */
export const sagaBeganOf = (taskId: string): string =>
  `EXISTS (SELECT 1 FROM checkpoints sp
           WHERE sp.task_id = ${taskId}
             AND sp.checkpoint_name = '${SAGA_PHASE_CHECKPOINT}')`

/**
 * `name` starts with `prefix`, exactly. LIKE would not do: it folds ASCII case on one
 * dialect and not another, and a reserved prefix is matched the same way everywhere.
 */
const namedUnder = (name: string, prefix: string): string =>
  `substr(${name}, 1, ${prefix.length}) = '${prefix}'`

/**
 * What the saga phase requires of a checkpoint write, as one predicate for every name:
 * a rollback's checkpoint is written only once the saga began, and any other only before.
 */
export const checkpointInItsPhase = (task: string, name: string): string =>
  `(${namedUnder(name, SAGA_ROLLBACK_PREFIX)}) = (${sagaBegan(task)})`

/** The rollback of the step a saga checkpoint `marker` names has run. */
const rollbackRan = (marker: string, prefix: string): string =>
  `EXISTS (SELECT 1 FROM checkpoints sr
           WHERE sr.task_id = ${marker}.task_id
             AND sr.checkpoint_name = '${SAGA_ROLLBACK_PREFIX}'
               || substr(${marker}.checkpoint_name, ${prefix.length + 1}))`

/** A registered step of the task started, and its rollback has not run. */
export const rollbackPending = (task: string): string =>
  `EXISTS (SELECT 1 FROM checkpoints ss
           WHERE ss.task_id = ${task}.task_id
             AND ${namedUnder('ss.checkpoint_name', SAGA_STARTED_PREFIX)}
             AND NOT ${rollbackRan('ss', SAGA_STARTED_PREFIX)})`

/**
 * A terminal task's rollback outcome and the attempt record of the rollback that halted
 * it, as `decodeRollbackOutcome` reads them. Both are derived from the saga's
 * checkpoints when they are read and stored nowhere, so they cannot disagree with them:
 * `failed` exactly when a step that started is left uncompensated. No checkpoint of a
 * terminal task changes, so the answer does not either.
 */
export const rollbackOutcomeColumns = (task: string): string =>
  `CASE WHEN ${task}.state NOT IN ${LIVE} AND ${sagaBegan(task)}
        THEN CASE WHEN ${rollbackPending(task)} THEN 'failed' ELSE 'complete' END
   END AS rollback_outcome,
   (SELECT st.state FROM checkpoints st
     WHERE st.task_id = ${task}.task_id
       AND ${namedUnder('st.checkpoint_name', SAGA_TRIES_PREFIX)}
       AND NOT ${rollbackRan('st', SAGA_TRIES_PREFIX)}
     ORDER BY st.owner_attempt DESC, st.checkpoint_name LIMIT 1) AS rollback_error`

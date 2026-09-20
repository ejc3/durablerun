import {
  IDENTIFIER_CHARACTERS,
  type IntegerBounds,
  PERSISTED_INTEGER_BOUNDS,
  PERSISTED_TEMPORAL_FIELDS,
  type PersistedTemporalFieldDescriptor,
  type PersistedTemporalFieldId,
  type PersistedTemporalTable,
  type SqlExecutor,
  type SqlResult,
  type SqlRow,
  decodeBoundedInteger,
  fitsCharacters,
  isLiveState,
  isTerminalState,
  parseFenceStamp,
  taskResultContradictions,
} from '@durablerun/core'

/**
 * Atomic conditions claimed by the invariant library. The evaluator can only
 * emit a finding through one of these IDs, and the poison surface checks this
 * exact inventory rather than the coarser user-facing invariant names.
 */
const STATIC_ENGINE_INVARIANT_CONDITION_NAMES = Object.freeze({
  'terminal-task/live-run': 'terminal-task-with-live-run',
  'lease/running-owner-null': 'ownerless-running-run',
  'mirror/running-run-task-not-running': 'running-run-under-non-running-task',
  'mirror/running-task-no-live-run': 'running-task-with-no-live-run',
  'cardinality/multiple-live-runs': 'multiple-live-runs-per-task',
  'attempts/over-max': 'attempts-exceeds-cap',
  'attempts/at-max-with-live-run': 'attempt-budget-exhausted-with-live-run',
  'task-outcome/completed-without-payload': 'task-outcome-completed-without-payload',
  'task-outcome/payload-on-other-state': 'task-outcome-payload-on-other-state',
  'task-outcome/failure-without-reason': 'task-outcome-failure-without-reason',
  'task-outcome/reason-on-other-state': 'task-outcome-reason-on-other-state',
  'accounting/above-top': 'attempt-accounting-drift',
  'accounting/below-top-minus-one': 'attempt-accounting-drift',
  'accounting/live-run-not-next': 'attempt-accounting-drift',
  'accounting/failed-charge-past-budget': 'attempt-accounting-drift',
  'checkpoint/task-mismatch': 'checkpoint-cross-task',
  'checkpoint/queue-mismatch': 'checkpoint-cross-task',
  'checkpoint/owner-attempt-mismatch': 'checkpoint-owner-attempt-mismatch',
  'wait/dead-run': 'wait-referencing-dead-run',
  'cardinality/live-task-zero-runs': 'live-task-without-exactly-one-live-run',
  'cardinality/live-task-multiple-runs': 'live-task-without-exactly-one-live-run',
  'mirror/live-state-mismatch': 'task-run-state-mismatch',
  'ownership/run-task-missing': 'run-owner-missing',
  'ownership/run-task-queue-mismatch': 'run-task-queue-mismatch',
  'checkpoint/owner-missing': 'checkpoint-owner-run-missing',
  'wait/run-missing': 'wait-run-missing',
  'wait/task-mismatch': 'wait-cross-task',
  'wait/queue-mismatch': 'wait-cross-task',
  'wait/fired-event': 'wait-for-fired-event',
  'wait/run-not-sleeping': 'wait-on-non-sleeping-run',
  'wait/wake-name-null': 'wait-wake-name-mismatch',
  'wait/wake-name-different': 'wait-wake-name-mismatch',
  'wait/untimed-wait-timed-run': 'wait-timeout-availability-mismatch',
  'wait/timed-wait-untimed-run': 'wait-timeout-availability-mismatch',
  'wait/deadlines-differ': 'wait-timeout-availability-mismatch',
  'event/payload-null': 'event-payload-null',
  'payload/event-missing': 'wake-payload-mismatch',
  'payload/stored-payload-null': 'wake-payload-mismatch',
  'payload/stored-payload-different': 'wake-payload-mismatch',
  'provenance/stamp-without-instant': 'provenance-pair-broken',
  'provenance/instant-without-stamp': 'provenance-pair-broken',
  'provenance/instant-not-integer': 'provenance-pair-broken',
  'provenance/stamp-not-text': 'provenance-pair-broken',
  'provenance/no-separator': 'provenance-pair-broken',
  'provenance/empty-seed': 'provenance-pair-broken',
  'provenance/empty-statement': 'provenance-pair-broken',
  'provenance/statement-name-invalid': 'provenance-pair-broken',
  'provenance/one-seed-two-instants': 'one-batch-two-instants',
  'generation/activated-after-claim': 'generation-or-counter-corrupt',
  'generation/negative-claim': 'generation-or-counter-corrupt',
  'generation/negative-relaunch': 'generation-or-counter-corrupt',
  'generation/negative-attempts': 'generation-or-counter-corrupt',
  'generation/negative-infra-retries': 'generation-or-counter-corrupt',
  'counter/task-attempts': 'counter-storage-class',
  'counter/task-max-attempts': 'counter-storage-class',
  'counter/task-infra-retries': 'counter-storage-class',
  'counter/run-attempt': 'counter-storage-class',
  'counter/run-claim-gen': 'counter-storage-class',
  'counter/run-activated-gen': 'counter-storage-class',
  'counter/run-relaunch-count': 'counter-storage-class',
  'counter/checkpoint-owner-attempt': 'counter-storage-class',
  'counter-bound/task-attempts': 'counter-out-of-range',
  'counter-bound/task-max-attempts': 'counter-out-of-range',
  'counter-bound/task-infra-retries': 'counter-out-of-range',
  'counter-bound/run-attempt': 'counter-out-of-range',
  'counter-bound/run-claim-gen': 'counter-out-of-range',
  'counter-bound/run-activated-gen': 'counter-out-of-range',
  'counter-bound/run-relaunch-count': 'counter-out-of-range',
  'counter-bound/checkpoint-owner-attempt': 'counter-out-of-range',
  'identifier/over-width': 'identifier-over-width',
} as const)

export type TemporalStorageConditionId = `temporal/${PersistedTemporalFieldId}`
export type TemporalBoundConditionId = `temporal-bound/${PersistedTemporalFieldId}`

/**
 * Every persisted temporal field owns exactly two atomic conditions. Building
 * this record from the frozen inventory prevents a newly enrolled timestamp
 * from existing without both storage-class and semantic-bound coverage.
 */
const TEMPORAL_INVARIANT_CONDITION_NAMES = Object.freeze(
  Object.fromEntries(
    PERSISTED_TEMPORAL_FIELDS.flatMap(({ id }) => [
      [`temporal/${id}`, 'temporal-storage-class'],
      [`temporal-bound/${id}`, 'temporal-out-of-range'],
    ]),
  ),
) as Readonly<
  Record<TemporalStorageConditionId, 'temporal-storage-class'> &
    Record<TemporalBoundConditionId, 'temporal-out-of-range'>
>

export const ENGINE_INVARIANT_CONDITION_NAMES = Object.freeze({
  ...STATIC_ENGINE_INVARIANT_CONDITION_NAMES,
  ...TEMPORAL_INVARIANT_CONDITION_NAMES,
})

export type EngineInvariantConditionId = keyof typeof ENGINE_INVARIANT_CONDITION_NAMES

export const ENGINE_INVARIANT_CONDITIONS = Object.freeze(
  Object.entries(ENGINE_INVARIANT_CONDITION_NAMES).map(([id, name]) =>
    Object.freeze({ id: id as EngineInvariantConditionId, name }),
  ),
)

export const ENGINE_INVARIANT_NAMES: readonly string[] = Object.freeze(
  [...new Set(Object.values(ENGINE_INVARIANT_CONDITION_NAMES))].sort(),
)

export interface EngineInvariantFinding {
  conditionId: EngineInvariantConditionId
  name: string
  subject: string
  /** Canonical tuple identity; unlike the display subject, delimiters cannot collide. */
  subjectIdentity: readonly string[]
  message: string
}

type ProtocolRows = Readonly<Record<PersistedTemporalTable, readonly SqlRow[]>>

type SqlValue = SqlRow[string] | undefined

/**
 * Every column of the six snapshot tables that holds a durable identifier (DESIGN.md
 * §3.4 rule 10). MySQL bounds each at the width in its schema, and the checker test
 * holds this list to that schema. libSQL and PostgreSQL store unbounded text, so there
 * the `identifier/over-width` condition is all that reads the length of a stored name.
 */
export const IDENTIFIER_COLUMNS = Object.freeze({
  tasks: ['task_id', 'queue', 'idempotency_key', 'last_attempt_run'],
  runs: ['run_id', 'queue', 'task_id', 'wake_event', 'wake_step'],
  checkpoints: ['task_id', 'checkpoint_name', 'queue', 'owner_run_id'],
  events: ['queue', 'event_name'],
  waits: ['run_id', 'step_name', 'queue', 'task_id', 'event_name'],
  drivers: ['queue', 'driver_id'],
} as const satisfies Readonly<Record<PersistedTemporalTable, readonly string[]>>)

function withEnrolledColumns(
  table: PersistedTemporalTable,
  baseColumns: readonly string[],
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...baseColumns,
      ...IDENTIFIER_COLUMNS[table],
      ...PERSISTED_TEMPORAL_FIELDS.filter((field) => field.table === table).map(
        (field) => field.column,
      ),
    ]),
  ])
}

/**
 * The six portable table snapshots are closed over both inventories: adding a temporal
 * descriptor or an identifier column necessarily selects that durable column for
 * invariant evaluation.
 */
const SNAPSHOT_PROJECTIONS = [
  {
    table: 'tasks',
    columns: withEnrolledColumns('tasks', [
      'task_id',
      'queue',
      'state',
      'attempts',
      'max_attempts',
      'infra_retries',
      'completed_payload',
      'failure_reason',
      'fence_stamp',
    ]),
  },
  {
    table: 'runs',
    columns: withEnrolledColumns('runs', [
      'run_id',
      'queue',
      'task_id',
      'attempt',
      'state',
      'claimed_by',
      'claim_gen',
      'activated_gen',
      'relaunch_count',
      'wake_event',
      'event_payload',
      'fence_stamp',
    ]),
  },
  {
    table: 'checkpoints',
    columns: withEnrolledColumns('checkpoints', [
      'task_id',
      'checkpoint_name',
      'queue',
      'owner_run_id',
      'owner_attempt',
    ]),
  },
  {
    table: 'events',
    columns: withEnrolledColumns('events', ['queue', 'event_name', 'payload', 'fence_stamp']),
  },
  {
    table: 'waits',
    columns: withEnrolledColumns('waits', [
      'run_id',
      'step_name',
      'queue',
      'task_id',
      'event_name',
      'status',
      'fence_stamp',
    ]),
  },
  {
    table: 'drivers',
    columns: withEnrolledColumns('drivers', ['queue', 'driver_id']),
  },
] as const

const SNAPSHOT_STATEMENTS = SNAPSHOT_PROJECTIONS.map(({ table, columns }) => ({
  sql: `SELECT ${columns.join(', ')} FROM ${table}`,
  args: [],
}))

export function bindInvariantSnapshotRows(
  projections: readonly {
    table: PersistedTemporalTable
    columns: readonly string[]
  }[],
  results: readonly SqlResult[],
): ReadonlyMap<PersistedTemporalTable, readonly SqlRow[]> {
  if (results.length !== projections.length) {
    throw new Error(
      `invariant result count mismatch: expected ${projections.length}, got ${results.length}`,
    )
  }
  const rowsByTable = new Map<PersistedTemporalTable, readonly SqlRow[]>()
  projections.forEach(({ table, columns }, resultIndex) => {
    const result = results[resultIndex]
    if (!result || !Array.isArray(result.rows)) {
      throw new Error(`invariant snapshot result ${resultIndex} has no rows array`)
    }
    result.rows.forEach((row, rowIndex) => {
      const missing = columns.filter((column) => !Object.prototype.hasOwnProperty.call(row, column))
      if (missing.length > 0) {
        throw new Error(
          `invariant snapshot ${resultIndex} row ${rowIndex} missing columns: ${missing.join(', ')}`,
        )
      }
    })
    rowsByTable.set(table, result.rows)
  })
  return rowsByTable
}

function text(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`invariant snapshot expected text column '${column}'`)
  }
  return value
}

function sameValue(left: SqlValue, right: SqlValue): boolean {
  if (left === right) return true
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  if (
    (typeof left === 'number' || typeof left === 'bigint') &&
    (typeof right === 'number' || typeof right === 'bigint')
  ) {
    if (typeof left === 'number' && !Number.isSafeInteger(left)) return false
    if (typeof right === 'number' && !Number.isSafeInteger(right)) return false
    return BigInt(left) === BigInt(right)
  }
  return false
}

/**
 * The language-neutral schema stores engine time and lease durations as
 * integer epoch-milliseconds. Drivers may surface those integers as either
 * safe JS numbers or bigint; strings (including parseable date strings) are a
 * different storage representation and remain corruption.
 */
function validTemporal(value: SqlValue, bounds: IntegerBounds): boolean {
  if (value === null) return true
  return decodeBoundedInteger(value, bounds).ok
}

/** One event's key, as one string. The child-task checker keys events the same way. */
export function eventKey(queue: string, eventName: string): string {
  return JSON.stringify([queue, eventName])
}

function rowSubject(
  table: PersistedTemporalTable,
  row: SqlRow,
): { subject: string; identity: readonly string[] } {
  switch (table) {
    case 'tasks': {
      const taskId = text(row, 'task_id')
      return { subject: `tasks/${taskId}`, identity: ['tasks', taskId] }
    }
    case 'runs': {
      const runId = text(row, 'run_id')
      return { subject: `runs/${runId}`, identity: ['runs', runId] }
    }
    case 'checkpoints': {
      const taskId = text(row, 'task_id')
      const checkpointName = text(row, 'checkpoint_name')
      return {
        subject: `checkpoints/${taskId}/${checkpointName}`,
        identity: ['checkpoints', taskId, checkpointName],
      }
    }
    case 'events': {
      const queue = text(row, 'queue')
      const eventName = text(row, 'event_name')
      return {
        subject: `events/${queue}/${eventName}`,
        identity: ['events', queue, eventName],
      }
    }
    case 'waits': {
      const runId = text(row, 'run_id')
      const stepName = text(row, 'step_name')
      return {
        subject: `waits/${runId}/${stepName}`,
        identity: ['waits', runId, stepName],
      }
    }
    case 'drivers': {
      const queue = text(row, 'queue')
      const driverId = text(row, 'driver_id')
      return {
        subject: `drivers/${queue}/${driverId}`,
        identity: ['drivers', queue, driverId],
      }
    }
  }
}

function evaluate(rows: ProtocolRows): EngineInvariantFinding[] {
  const findings: EngineInvariantFinding[] = []
  const add = (
    conditionId: EngineInvariantConditionId,
    subject: string,
    subjectIdentity: readonly string[] = [subject],
  ): void => {
    const name = ENGINE_INVARIANT_CONDITION_NAMES[conditionId]
    findings.push({
      conditionId,
      name,
      subject,
      subjectIdentity: Object.freeze([...subjectIdentity]),
      message: `${name}: ${subject}`,
    })
  }
  const count = (
    value: SqlValue,
    storageCondition: EngineInvariantConditionId,
    boundCondition: EngineInvariantConditionId,
    subject: string,
    identity: readonly string[],
    bounds: IntegerBounds,
  ): { value: bigint | undefined; exact: bigint | undefined } => {
    const decoded = decodeBoundedInteger(value, bounds)
    if (decoded.ok) return { value: decoded.exact, exact: decoded.exact }
    add(
      decoded.reason === 'not-an-exact-integer' ? storageCondition : boundCondition,
      subject,
      identity,
    )
    return {
      value: undefined,
      exact: decoded.reason === 'out-of-range' ? decoded.exact : undefined,
    }
  }
  const temporal = (
    value: SqlValue,
    field: PersistedTemporalFieldDescriptor,
    subject: string,
    identity: readonly string[],
  ): void => {
    if (value === null && field.nullable) return
    const decoded = decodeBoundedInteger(value, field.bounds)
    if (decoded.ok) return
    add(
      decoded.reason === 'not-an-exact-integer'
        ? (`temporal/${field.id}` as TemporalStorageConditionId)
        : (`temporal-bound/${field.id}` as TemporalBoundConditionId),
      subject,
      identity,
    )
  }

  const tasks = new Map(rows.tasks.map((row) => [text(row, 'task_id'), row]))
  const runs = new Map(rows.runs.map((row) => [text(row, 'run_id'), row]))
  const events = new Map(
    rows.events.map((row) => [eventKey(text(row, 'queue'), text(row, 'event_name')), row]),
  )
  for (const event of rows.events) {
    // An await that timed out answers with no payload, so an event that held SQL NULL would
    // read as a timeout. Every dialect's schema refuses the write, and this is its twin for
    // a database whose schema was tampered with or never reached that version.
    if (event.payload === null) {
      const { subject, identity } = rowSubject('events', event)
      add('event/payload-null', subject, identity)
    }
  }
  const runsByTask = new Map<string, SqlRow[]>()
  for (const run of rows.runs) {
    const taskId = text(run, 'task_id')
    const owned = runsByTask.get(taskId) ?? []
    owned.push(run)
    runsByTask.set(taskId, owned)
  }

  // Evaluation is generated at the same altitude as condition enrollment.
  // There is no table-specific temporal call site to forget when the schema
  // gains a field.
  for (const field of PERSISTED_TEMPORAL_FIELDS) {
    for (const row of rows[field.table]) {
      const { subject, identity } = rowSubject(field.table, row)
      temporal(row[field.column], field, subject, identity)
    }
  }

  // The width of a durable identifier (DESIGN.md §3.4 rule 10), read from every identifier
  // column and counted by core's own function. The port refuses a longer name on the way
  // in, so a row that holds one was written by an older build, or holds a name the engine
  // derived and nothing held.
  for (const table of Object.keys(IDENTIFIER_COLUMNS) as PersistedTemporalTable[]) {
    for (const row of rows[table]) {
      for (const column of IDENTIFIER_COLUMNS[table]) {
        const value = row[column]
        if (typeof value !== 'string' || fitsCharacters(value, IDENTIFIER_CHARACTERS)) continue
        const { subject, identity } = rowSubject(table, row)
        add('identifier/over-width', `${table}.${column} of ${subject}`, [...identity, column])
      }
    }
  }

  interface TaskCounters {
    attempts: bigint | undefined
    maxAttempts: bigint | undefined
    infraRetries: bigint | undefined
  }
  interface RunCounters {
    attempt: bigint | undefined
    claimGen: bigint | undefined
    activatedGen: bigint | undefined
    relaunchCount: bigint | undefined
  }
  const taskCounters = new Map<string, TaskCounters>()
  for (const task of rows.tasks) {
    const taskId = text(task, 'task_id')
    const subject = `tasks/${taskId}`
    const identity = ['tasks', taskId]
    const attempts = count(
      task.attempts,
      'counter/task-attempts',
      'counter-bound/task-attempts',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.tasks.attempts,
    )
    const maxAttempts = count(
      task.max_attempts,
      'counter/task-max-attempts',
      'counter-bound/task-max-attempts',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.tasks.max_attempts,
    )
    const infraRetries = count(
      task.infra_retries,
      'counter/task-infra-retries',
      'counter-bound/task-infra-retries',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.tasks.infra_retries,
    )
    if (attempts.exact !== undefined && attempts.exact < 0n) {
      add('generation/negative-attempts', taskId)
    }
    if (infraRetries.exact !== undefined && infraRetries.exact < 0n) {
      add('generation/negative-infra-retries', taskId)
    }
    taskCounters.set(taskId, {
      attempts: attempts.value,
      maxAttempts: maxAttempts.value,
      infraRetries: infraRetries.value,
    })
  }
  const runCounters = new Map<string, RunCounters>()
  for (const run of rows.runs) {
    const runId = text(run, 'run_id')
    const subject = `runs/${runId}`
    const identity = ['runs', runId]
    const attempt = count(
      run.attempt,
      'counter/run-attempt',
      'counter-bound/run-attempt',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.runs.attempt,
    )
    const claimGen = count(
      run.claim_gen,
      'counter/run-claim-gen',
      'counter-bound/run-claim-gen',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.runs.claim_gen,
    )
    const activatedGen = count(
      run.activated_gen,
      'counter/run-activated-gen',
      'counter-bound/run-activated-gen',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.runs.activated_gen,
    )
    const relaunchCount = count(
      run.relaunch_count,
      'counter/run-relaunch-count',
      'counter-bound/run-relaunch-count',
      subject,
      identity,
      PERSISTED_INTEGER_BOUNDS.runs.relaunch_count,
    )
    if (claimGen.exact !== undefined && claimGen.exact < 0n) {
      add('generation/negative-claim', runId)
    }
    if (relaunchCount.exact !== undefined && relaunchCount.exact < 0n) {
      add('generation/negative-relaunch', runId)
    }
    runCounters.set(runId, {
      attempt: attempt.value,
      claimGen: claimGen.value,
      activatedGen: activatedGen.value,
      relaunchCount: relaunchCount.value,
    })
  }

  for (const task of rows.tasks) {
    const taskId = text(task, 'task_id')
    const state = text(task, 'state')
    // taskResultContradictions throws for a missing column or an unknown state. The
    // projection selects every outcome column, and both schemas refuse an unknown
    // state with a CHECK constraint, so a throw here is a harness or dialect defect
    // that fails the evaluation loudly instead of hiding as a finding.
    for (const contradiction of taskResultContradictions(taskId, task)) {
      add(`task-outcome/${contradiction}`, taskId)
    }
    const counters = taskCounters.get(taskId)
    if (!counters) throw new Error(`counter snapshot missing task '${taskId}'`)
    const ownedRuns = runsByTask.get(taskId) ?? []
    const liveRuns = ownedRuns.filter((run) => isLiveState(text(run, 'state')))
    if (isTerminalState(state)) {
      for (const run of liveRuns) {
        const runId = text(run, 'run_id')
        add('terminal-task/live-run', `${taskId}/${runId}`, [taskId, runId])
      }
    }
    if (state === 'running' && liveRuns.length === 0) {
      add('mirror/running-task-no-live-run', taskId)
    }
    if (isLiveState(state)) {
      if (liveRuns.length === 0) add('cardinality/live-task-zero-runs', taskId)
      if (liveRuns.length > 1) add('cardinality/live-task-multiple-runs', taskId)
      for (const run of liveRuns) {
        if (text(run, 'state') !== state) {
          const runId = text(run, 'run_id')
          add('mirror/live-state-mismatch', `${taskId}/${runId}`, [taskId, runId])
        }
      }
    }
    if (
      counters.attempts !== undefined &&
      counters.maxAttempts !== undefined &&
      counters.attempts > counters.maxAttempts
    ) {
      add('attempts/over-max', taskId)
    }
    if (
      isLiveState(state) &&
      liveRuns.length > 0 &&
      counters.attempts !== undefined &&
      counters.maxAttempts !== undefined &&
      counters.attempts >= counters.maxAttempts
    ) {
      add('attempts/at-max-with-live-run', taskId)
    }

    const ownedAttempts = ownedRuns.map((run) => runCounters.get(text(run, 'run_id'))?.attempt)
    const top =
      ownedAttempts.length === 0 || ownedAttempts.some((attempt) => attempt === undefined)
        ? null
        : (ownedAttempts as bigint[]).reduce((maximum, attempt) =>
            attempt > maximum ? attempt : maximum,
          )
    if (top !== null) {
      if (counters.attempts !== undefined && counters.infraRetries !== undefined) {
        const accounted = counters.attempts + counters.infraRetries
        if (accounted > top) add('accounting/above-top', taskId)
        if (accounted < top - 1n) add('accounting/below-top-minus-one', taskId)
        if (isLiveState(state) && liveRuns.length === 1) {
          const liveAttempt = runCounters.get(text(liveRuns[0] as SqlRow, 'run_id'))?.attempt
          if (liveAttempt !== undefined && liveAttempt !== accounted + 1n) {
            add('accounting/live-run-not-next', taskId)
          }
        }
      }
      // TLA FailedChargeWithinBudget: a revival charges the top run net of
      // infrastructure retries, and that charge never exceeds the budget.
      if (
        state === 'failed' &&
        counters.infraRetries !== undefined &&
        counters.maxAttempts !== undefined &&
        top - counters.infraRetries > counters.maxAttempts
      ) {
        add('accounting/failed-charge-past-budget', taskId)
      }
    }
  }

  const liveCounts = new Map<string, number>()
  for (const run of rows.runs) {
    const runId = text(run, 'run_id')
    const taskId = text(run, 'task_id')
    const state = text(run, 'state')
    const counters = runCounters.get(runId)
    if (!counters) throw new Error(`counter snapshot missing run '${runId}'`)
    if (isLiveState(state)) liveCounts.set(taskId, (liveCounts.get(taskId) ?? 0) + 1)
    if (state === 'running' && run.claimed_by === null) add('lease/running-owner-null', runId)
    const task = tasks.get(taskId)
    if (!task) {
      add('ownership/run-task-missing', runId)
    } else if (text(run, 'queue') !== text(task, 'queue')) {
      add('ownership/run-task-queue-mismatch', runId)
    }
    if (state === 'running' && task && text(task, 'state') !== 'running') {
      add('mirror/running-run-task-not-running', runId)
    }
    if (
      counters.activatedGen !== undefined &&
      counters.claimGen !== undefined &&
      counters.activatedGen > counters.claimGen
    ) {
      add('generation/activated-after-claim', runId)
    }
    if (run.event_payload !== null) {
      const stored =
        run.wake_event === null
          ? undefined
          : events.get(eventKey(text(run, 'queue'), text(run, 'wake_event')))
      if (!stored) add('payload/event-missing', runId)
      else if (stored.payload === null) add('payload/stored-payload-null', runId)
      else if (!sameValue(run.event_payload, stored.payload)) {
        add('payload/stored-payload-different', runId)
      }
    }
  }
  for (const [taskId, count] of liveCounts) {
    if (count > 1) add('cardinality/multiple-live-runs', taskId)
  }

  for (const checkpoint of rows.checkpoints) {
    const taskId = text(checkpoint, 'task_id')
    const checkpointName = text(checkpoint, 'checkpoint_name')
    const subject = `${taskId}/${checkpointName}`
    const subjectIdentity = [taskId, checkpointName]
    const ownerAttempt = count(
      checkpoint.owner_attempt,
      'counter/checkpoint-owner-attempt',
      'counter-bound/checkpoint-owner-attempt',
      `checkpoints/${subject}`,
      ['checkpoints', ...subjectIdentity],
      PERSISTED_INTEGER_BOUNDS.checkpoints.owner_attempt,
    )
    const ownerRunId = text(checkpoint, 'owner_run_id')
    const owner = runs.get(ownerRunId)
    if (!owner) add('checkpoint/owner-missing', subject, subjectIdentity)
    else {
      if (text(owner, 'task_id') !== taskId) {
        add('checkpoint/task-mismatch', subject, subjectIdentity)
      }
      if (text(owner, 'queue') !== text(checkpoint, 'queue')) {
        add('checkpoint/queue-mismatch', subject, subjectIdentity)
      }
      const ownerRunAttempt = runCounters.get(ownerRunId)?.attempt
      if (
        ownerAttempt.value !== undefined &&
        ownerRunAttempt !== undefined &&
        ownerAttempt.value !== ownerRunAttempt
      ) {
        add('checkpoint/owner-attempt-mismatch', subject, subjectIdentity)
      }
    }
  }

  for (const wait of rows.waits) {
    const runId = text(wait, 'run_id')
    const stepName = text(wait, 'step_name')
    const subject = `${runId}/${stepName}`
    const subjectIdentity = [runId, stepName]
    const run = runs.get(runId)
    const fired = events.has(eventKey(text(wait, 'queue'), text(wait, 'event_name')))
    if (text(wait, 'status') === 'waiting' && fired) {
      add('wait/fired-event', subject, subjectIdentity)
    }
    if (!run) {
      add('wait/run-missing', subject, subjectIdentity)
      continue
    }
    if (!isLiveState(text(run, 'state'))) add('wait/dead-run', subject, subjectIdentity)
    if (text(run, 'task_id') !== text(wait, 'task_id')) {
      add('wait/task-mismatch', subject, subjectIdentity)
    }
    if (text(run, 'queue') !== text(wait, 'queue')) {
      add('wait/queue-mismatch', subject, subjectIdentity)
    }
    if (text(wait, 'status') !== 'waiting') continue

    if (text(run, 'state') !== 'sleeping') {
      add('wait/run-not-sleeping', subject, subjectIdentity)
    }
    if (run.wake_event === null) add('wait/wake-name-null', subject, subjectIdentity)
    else if (!sameValue(run.wake_event, wait.event_name)) {
      add('wait/wake-name-different', subject, subjectIdentity)
    }

    if (wait.timeout_at_ms === null && run.available_at_ms !== null) {
      add('wait/untimed-wait-timed-run', subject, subjectIdentity)
    } else if (wait.timeout_at_ms !== null && run.available_at_ms === null) {
      add('wait/timed-wait-untimed-run', subject, subjectIdentity)
    } else if (!sameValue(wait.timeout_at_ms, run.available_at_ms)) {
      add('wait/deadlines-differ', subject, subjectIdentity)
    }
  }

  const provenanceRows: Array<{
    source: string
    key: string
    identity: readonly string[]
    row: SqlRow
    instantBounds: IntegerBounds
  }> = [
    ...rows.tasks.map((row) => {
      const taskId = text(row, 'task_id')
      return {
        source: 'tasks',
        key: taskId,
        identity: ['tasks', taskId],
        row,
        instantBounds: PERSISTED_INTEGER_BOUNDS.tasks.fence_at_ms,
      }
    }),
    ...rows.runs.map((row) => {
      const runId = text(row, 'run_id')
      return {
        source: 'runs',
        key: runId,
        identity: ['runs', runId],
        row,
        instantBounds: PERSISTED_INTEGER_BOUNDS.runs.fence_at_ms,
      }
    }),
    ...rows.waits.map((row) => ({
      source: 'waits',
      key: `${text(row, 'run_id')}/${text(row, 'step_name')}`,
      identity: ['waits', text(row, 'run_id'), text(row, 'step_name')],
      row,
      instantBounds: PERSISTED_INTEGER_BOUNDS.waits.fence_at_ms,
    })),
    ...rows.events.map((row) => ({
      source: 'events',
      key: `${text(row, 'queue')}/${text(row, 'event_name')}`,
      identity: ['events', text(row, 'queue'), text(row, 'event_name')],
      row,
      instantBounds: PERSISTED_INTEGER_BOUNDS.events.fence_at_ms,
    })),
  ]
  const instantsBySeed = new Map<string, Set<string>>()
  for (const { source, key, identity, row, instantBounds } of provenanceRows) {
    const subject = `${source}/${key}`
    const stamp = row.fence_stamp
    const instant = row.fence_at_ms
    const hasStamp = stamp !== null && stamp !== undefined
    const hasInstant = instant !== null && instant !== undefined
    if (hasStamp && !hasInstant) {
      add('provenance/stamp-without-instant', subject, identity)
      continue
    }
    if (!hasStamp && hasInstant) {
      add('provenance/instant-without-stamp', subject, identity)
      continue
    }
    if (!hasStamp || !hasInstant) continue
    let validPair = true
    let seed: string | undefined
    if (!validTemporal(instant, instantBounds)) {
      add('provenance/instant-not-integer', subject, identity)
      validPair = false
    }
    if (typeof stamp !== 'string') {
      add('provenance/stamp-not-text', subject, identity)
      validPair = false
    } else {
      const parsed = parseFenceStamp(stamp)
      if (!parsed.ok) {
        const condition = {
          'no-separator': 'provenance/no-separator',
          'empty-seed': 'provenance/empty-seed',
          'empty-statement': 'provenance/empty-statement',
          'statement-name-invalid': 'provenance/statement-name-invalid',
        } as const
        add(condition[parsed.reason], subject, identity)
        validPair = false
      } else {
        seed = parsed.seed
      }
    }
    if (!validPair || seed === undefined) continue
    const instants = instantsBySeed.get(seed) ?? new Set<string>()
    instants.add(String(instant))
    instantsBySeed.set(seed, instants)
  }
  for (const [seed, instants] of instantsBySeed) {
    if (instants.size < 2) continue
    const ordered = [...instants].sort((left, right) => {
      if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) {
        const leftInteger = BigInt(left)
        const rightInteger = BigInt(right)
        if (leftInteger < rightInteger) return -1
        if (leftInteger > rightInteger) return 1
      }
      return left.localeCompare(right)
    })
    add('provenance/one-seed-two-instants', `${seed} saw ${ordered[0]} and ${ordered.at(-1)}`, [
      seed,
    ])
  }

  return findings.sort(
    (left, right) =>
      left.conditionId.localeCompare(right.conditionId) ||
      left.subject.localeCompare(right.subject),
  )
}

/**
 * Portable invariant runner: every backend returns the same six shared-table
 * snapshots, and all NULL-safe comparisons, joins, type checks and rendering
 * happen in TypeScript. No SQLite operator or function is part of the
 * conformance contract.
 */
export async function engineInvariantFindings(raw: SqlExecutor): Promise<EngineInvariantFinding[]> {
  const results = await raw.batch('invariants', SNAPSHOT_STATEMENTS, 'read')
  const rowsByTable = bindInvariantSnapshotRows(SNAPSHOT_PROJECTIONS, results)
  const requiredRows = (table: PersistedTemporalTable): readonly SqlRow[] => {
    const rows = rowsByTable.get(table)
    if (!rows) throw new Error(`invariant snapshot omitted table '${table}'`)
    return rows
  }
  return evaluate({
    tasks: requiredRows('tasks'),
    runs: requiredRows('runs'),
    checkpoints: requiredRows('checkpoints'),
    events: requiredRows('events'),
    waits: requiredRows('waits'),
    drivers: requiredRows('drivers'),
  })
}

export async function engineInvariantViolations(raw: SqlExecutor): Promise<string[]> {
  return [...new Set((await engineInvariantFindings(raw)).map((violation) => violation.message))]
}

export async function assertEngineInvariants(raw: SqlExecutor): Promise<void> {
  const violations = await engineInvariantViolations(raw)
  if (violations.length > 0) {
    throw new Error(`engine invariant violations:\n  ${violations.join('\n  ')}`)
  }
}

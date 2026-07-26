import {
  decodeBoundedInteger,
  MAX_COUNT,
  MAX_DURATION_MS,
  MAX_EPOCH_MS,
  MAX_RUN_ORDINAL,
  type SqlExecutor,
  type SqlRow,
  isLiveState,
  isTerminalState,
  parseFenceStamp,
} from '@durablerun/core'

/**
 * Atomic conditions claimed by the invariant library. The evaluator can only
 * emit a finding through one of these IDs, and the poison surface checks this
 * exact inventory rather than the coarser user-facing invariant names.
 */
export const ENGINE_INVARIANT_CONDITION_NAMES = Object.freeze({
  'terminal-task/live-run': 'terminal-task-with-live-run',
  'lease/running-owner-null': 'ownerless-running-run',
  'mirror/running-run-task-not-running': 'running-run-under-non-running-task',
  'mirror/running-task-no-live-run': 'running-task-with-no-live-run',
  'cardinality/multiple-live-runs': 'multiple-live-runs-per-task',
  'attempts/over-max': 'attempts-exceeds-cap',
  'accounting/above-top': 'attempt-accounting-drift',
  'accounting/below-top-minus-one': 'attempt-accounting-drift',
  'checkpoint/task-mismatch': 'checkpoint-cross-task',
  'checkpoint/queue-mismatch': 'checkpoint-cross-task',
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
  'payload/event-missing': 'wake-payload-mismatch',
  'payload/stored-payload-null': 'wake-payload-mismatch',
  'payload/stored-payload-different': 'wake-payload-mismatch',
  'temporal/run-available': 'temporal-storage-class',
  'temporal/run-claim-expires': 'temporal-storage-class',
  'temporal/run-heartbeat': 'temporal-storage-class',
  'temporal/run-created': 'temporal-storage-class',
  'temporal/run-lease': 'temporal-storage-class',
  'temporal/task-enqueue': 'temporal-storage-class',
  'temporal/task-cancel': 'temporal-storage-class',
  'temporal/checkpoint-updated': 'temporal-storage-class',
  'temporal-bound/run-available': 'temporal-out-of-range',
  'temporal-bound/run-claim-expires': 'temporal-out-of-range',
  'temporal-bound/run-heartbeat': 'temporal-out-of-range',
  'temporal-bound/run-created': 'temporal-out-of-range',
  'temporal-bound/run-lease': 'temporal-out-of-range',
  'temporal-bound/task-enqueue': 'temporal-out-of-range',
  'temporal-bound/task-cancel': 'temporal-out-of-range',
  'temporal-bound/checkpoint-updated': 'temporal-out-of-range',
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
  'counter-bound/task-attempts': 'counter-out-of-range',
  'counter-bound/task-max-attempts': 'counter-out-of-range',
  'counter-bound/task-infra-retries': 'counter-out-of-range',
  'counter-bound/run-attempt': 'counter-out-of-range',
  'counter-bound/run-claim-gen': 'counter-out-of-range',
  'counter-bound/run-activated-gen': 'counter-out-of-range',
  'counter-bound/run-relaunch-count': 'counter-out-of-range',
} as const)

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

interface ProtocolRows {
  tasks: readonly SqlRow[]
  runs: readonly SqlRow[]
  checkpoints: readonly SqlRow[]
  events: readonly SqlRow[]
  waits: readonly SqlRow[]
}

type SqlValue = SqlRow[string] | undefined

const SNAPSHOT_PROJECTIONS = [
  {
    table: 'tasks',
    columns: [
      'task_id',
      'queue',
      'state',
      'attempts',
      'max_attempts',
      'infra_retries',
      'enqueue_at_ms',
      'cancel_at_ms',
      'fence_stamp',
      'fence_at_ms',
    ],
  },
  {
    table: 'runs',
    columns: [
      'run_id',
      'queue',
      'task_id',
      'attempt',
      'state',
      'claimed_by',
      'claim_gen',
      'activated_gen',
      'relaunch_count',
      'lease_ms',
      'claim_expires_at_ms',
      'heartbeat_at_ms',
      'available_at_ms',
      'created_at_ms',
      'wake_event',
      'event_payload',
      'fence_stamp',
      'fence_at_ms',
    ],
  },
  {
    table: 'checkpoints',
    columns: ['task_id', 'checkpoint_name', 'queue', 'owner_run_id', 'updated_at_ms'],
  },
  {
    table: 'events',
    columns: ['queue', 'event_name', 'payload', 'fence_stamp', 'fence_at_ms'],
  },
  {
    table: 'waits',
    columns: [
      'run_id',
      'step_name',
      'queue',
      'task_id',
      'event_name',
      'status',
      'timeout_at_ms',
      'fence_stamp',
      'fence_at_ms',
    ],
  },
] as const

const SNAPSHOT_STATEMENTS = SNAPSHOT_PROJECTIONS.map(({ table, columns }) => ({
  sql: `SELECT ${columns.join(', ')} FROM ${table}`,
  args: [],
}))

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
function validTemporal(value: SqlValue): boolean {
  if (value === null) return true
  return decodeBoundedInteger(value, { min: 0, max: MAX_EPOCH_MS }).ok
}

function eventKey(queue: string, eventName: string): string {
  return JSON.stringify([queue, eventName])
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
    minimum = 0,
    maximum = MAX_COUNT,
  ): { value: bigint | undefined; exact: bigint | undefined } => {
    const decoded = decodeBoundedInteger(value, { min: minimum, max: maximum })
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
    storageCondition: EngineInvariantConditionId,
    boundCondition: EngineInvariantConditionId,
    subject: string,
    identity: readonly string[],
    maximum = MAX_EPOCH_MS,
  ): void => {
    if (value === null) return
    const decoded = decodeBoundedInteger(value, { min: 0, max: maximum })
    if (decoded.ok) return
    add(
      decoded.reason === 'not-an-exact-integer' ? storageCondition : boundCondition,
      subject,
      identity,
    )
  }

  const tasks = new Map(rows.tasks.map((row) => [text(row, 'task_id'), row]))
  const runs = new Map(rows.runs.map((row) => [text(row, 'run_id'), row]))
  const events = new Map(
    rows.events.map((row) => [eventKey(text(row, 'queue'), text(row, 'event_name')), row]),
  )
  const runsByTask = new Map<string, SqlRow[]>()
  for (const run of rows.runs) {
    const taskId = text(run, 'task_id')
    const owned = runsByTask.get(taskId) ?? []
    owned.push(run)
    runsByTask.set(taskId, owned)
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
    )
    const maxAttempts = count(
      task.max_attempts,
      'counter/task-max-attempts',
      'counter-bound/task-max-attempts',
      subject,
      identity,
      1,
    )
    const infraRetries = count(
      task.infra_retries,
      'counter/task-infra-retries',
      'counter-bound/task-infra-retries',
      subject,
      identity,
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
      1,
      MAX_RUN_ORDINAL,
    )
    const claimGen = count(
      run.claim_gen,
      'counter/run-claim-gen',
      'counter-bound/run-claim-gen',
      subject,
      identity,
    )
    const activatedGen = count(
      run.activated_gen,
      'counter/run-activated-gen',
      'counter-bound/run-activated-gen',
      subject,
      identity,
    )
    const relaunchCount = count(
      run.relaunch_count,
      'counter/run-relaunch-count',
      'counter-bound/run-relaunch-count',
      subject,
      identity,
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
      }
    }
    temporal(
      task.enqueue_at_ms,
      'temporal/task-enqueue',
      'temporal-bound/task-enqueue',
      `tasks/${taskId}`,
      ['tasks', taskId],
    )
    temporal(
      task.cancel_at_ms,
      'temporal/task-cancel',
      'temporal-bound/task-cancel',
      `tasks/${taskId}`,
      ['tasks', taskId],
    )
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
    temporal(
      run.available_at_ms,
      'temporal/run-available',
      'temporal-bound/run-available',
      `runs/${runId}`,
      ['runs', runId],
    )
    temporal(
      run.claim_expires_at_ms,
      'temporal/run-claim-expires',
      'temporal-bound/run-claim-expires',
      `runs/${runId}`,
      ['runs', runId],
    )
    temporal(
      run.heartbeat_at_ms,
      'temporal/run-heartbeat',
      'temporal-bound/run-heartbeat',
      `runs/${runId}`,
      ['runs', runId],
    )
    temporal(
      run.created_at_ms,
      'temporal/run-created',
      'temporal-bound/run-created',
      `runs/${runId}`,
      ['runs', runId],
    )
    temporal(
      run.lease_ms,
      'temporal/run-lease',
      'temporal-bound/run-lease',
      `runs/${runId}`,
      ['runs', runId],
      MAX_DURATION_MS,
    )
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
    const owner = runs.get(text(checkpoint, 'owner_run_id'))
    if (!owner) add('checkpoint/owner-missing', subject, subjectIdentity)
    else {
      if (text(owner, 'task_id') !== taskId) {
        add('checkpoint/task-mismatch', subject, subjectIdentity)
      }
      if (text(owner, 'queue') !== text(checkpoint, 'queue')) {
        add('checkpoint/queue-mismatch', subject, subjectIdentity)
      }
    }
    temporal(
      checkpoint.updated_at_ms,
      'temporal/checkpoint-updated',
      'temporal-bound/checkpoint-updated',
      `checkpoints/${subject}`,
      ['checkpoints', ...subjectIdentity],
    )
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
  }> = [
    ...rows.tasks.map((row) => {
      const taskId = text(row, 'task_id')
      return { source: 'tasks', key: taskId, identity: ['tasks', taskId], row }
    }),
    ...rows.runs.map((row) => {
      const runId = text(row, 'run_id')
      return { source: 'runs', key: runId, identity: ['runs', runId], row }
    }),
    ...rows.waits.map((row) => ({
      source: 'waits',
      key: `${text(row, 'run_id')}/${text(row, 'step_name')}`,
      identity: ['waits', text(row, 'run_id'), text(row, 'step_name')],
      row,
    })),
    ...rows.events.map((row) => ({
      source: 'events',
      key: `${text(row, 'queue')}/${text(row, 'event_name')}`,
      identity: ['events', text(row, 'queue'), text(row, 'event_name')],
      row,
    })),
  ]
  const instantsBySeed = new Map<string, Set<string>>()
  for (const { source, key, identity, row } of provenanceRows) {
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
    if (!validTemporal(instant)) {
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
 * Portable invariant runner: every backend returns the same five shared-table
 * snapshots, and all NULL-safe comparisons, joins, type checks and rendering
 * happen in TypeScript. No SQLite operator or function is part of the
 * conformance contract.
 */
export async function engineInvariantFindings(raw: SqlExecutor): Promise<EngineInvariantFinding[]> {
  const results = await raw.batch('invariants', SNAPSHOT_STATEMENTS, 'read')
  if (results.length !== SNAPSHOT_STATEMENTS.length) {
    throw new Error(
      `invariant result count mismatch: expected ${SNAPSHOT_STATEMENTS.length}, got ${results.length}`,
    )
  }
  const rows = SNAPSHOT_PROJECTIONS.map(({ columns }, resultIndex) => {
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
    return result.rows
  })
  return evaluate({
    tasks: rows[0] ?? [],
    runs: rows[1] ?? [],
    checkpoints: rows[2] ?? [],
    events: rows[3] ?? [],
    waits: rows[4] ?? [],
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

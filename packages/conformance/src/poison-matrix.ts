import {
  type IntegerBounds,
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_INTEGER_BOUNDS,
  PERSISTED_TEMPORAL_FIELDS,
  type PersistedCounterFieldDescriptor,
  type PersistedCounterFieldId,
  type PersistedTemporalFieldDescriptor,
  SAGA_PHASE_CHECKPOINT,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  type SqlBatchControl,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  isLiveState,
  isTerminalState,
  parseFenceStamp,
  sqlBatchMode,
  taskDoneEventName,
  taskIdOfDoneEvent,
} from '@durablerun/core'
import { MATRIX_WRITE_LABELS, TERMINAL_BATCH_LABELS } from './fault-matrix.js'
import {
  type StorageCorruption,
  type StorageCorruptionDisposition,
  type StoreFixture,
  type StoreFixtureFactory,
  executeStorageCorruption,
} from './fixture.js'
import {
  ENGINE_INVARIANT_CONDITIONS,
  type EngineInvariantConditionId,
  type EngineInvariantFinding,
  engineInvariantFindings,
} from './invariants.js'

/**
 * Generated corrupt-pre-state surface.
 *
 * The two axes have independent completeness gates: write labels come
 * directly from the fault-matrix inventory, while witnesses must cover every
 * exported atomic invariant condition ID. Each cell drives one targeted public-store
 * call through a recording executor, proving that the intended label really
 * crossed the SQL boundary.
 *
 * A corrupt state cannot be judged by "invariants are clean afterward": a
 * buggy transition can launder a terminal task and its live run into a
 * coherent-looking active pair. The oracle therefore audits the transition:
 * writes may not escape the authoritative owner closure, new findings may not
 * appear, and live authority may not grow. Terminal runs may be quiesced, but
 * a terminal task is immutable and an unchanged live run beneath it may not
 * be rewritten. The sole advisory exception is expire-lease-now, which may
 * only shorten claim_expires_at_ms. Emit-event also preserves a deliberately
 * declined poisoned registration; the resulting wait-for-fired-event finding
 * is the alarm that the refused wake was not laundered away.
 */

const Q = 'q'
const OTHER_Q = 'other-q'
const NOW = 1_000_000
const TASK = 'poison-task'
const RUN = 'poison-run'
const RUN_2 = 'poison-run-2'
const GHOST_RUN = 'poison-missing-run'
const CANARY_TASK = 'healthy-canary'
const TOKEN = 'poison-worker'
const EVENT = 'poison-event'
const STEP = '$await:poison'
const IDEMPOTENCY_KEY = 'poison-key'
const TRIGGER_TASK = 'label-trigger-task'
const TRIGGER_RUN = 'label-trigger-run'
const TRIGGER_TOKEN = 'trigger-worker'
/** Children that ended with no completion event, one for each invocation of `record-task-done`. */
const ENDED_CHILD = 'poison-ended-child'
const TRIGGER_ENDED_CHILD = 'label-trigger-ended-child'
const TRIGGER_EVENT = 'label-trigger-event'
const TRIGGER_STEP = '$await:trigger'
const TRIGGER_IDEMPOTENCY_KEY = 'label-trigger-key'
const TRIGGER_DRIVER = 'label-trigger-driver'
const POISON_DRIVER = 'poison-driver'
const PROTECTED_TASK = 'protected-task'
const PROTECTED_RUN = 'protected-run'
const PROTECTED_EVENT = 'protected-fired-event'
const PROTECTED_WAIT_EVENT = 'protected-wait-event'
const PROTECTED_STEP = '$await:protected'
const PROTECTED_DRIVER = 'protected-driver'

export type PoisonTargetArm = 'claim' | 'sweep:lost-launch' | 'sweep:claim-timeout'

type PoisonTargetProfileSeed<
  State extends 'pending' | 'sleeping' | 'running',
  ClaimedBy extends string | null,
  ClaimGen extends number,
  ActivatedGen extends number,
  LeaseMs extends number | null,
  ClaimExpiresAtMs extends number | null,
  HeartbeatAtMs extends number | null,
  AvailableAtMs extends number | null,
> = Readonly<{
  state: State
  taskAttempts: 0
  taskMaxAttempts: 5
  taskInfraRetries: 0
  runAttempt: 1
  claimedBy: ClaimedBy
  claimGen: ClaimGen
  activatedGen: ActivatedGen
  runRelaunchCount: 0
  leaseMs: LeaseMs
  claimExpiresAtMs: ClaimExpiresAtMs
  heartbeatAtMs: HeartbeatAtMs
  availableAtMs: AvailableAtMs
}>

export type PoisonTargetProfileSeedRecord = Readonly<{
  'claim-pending': PoisonTargetProfileSeed<'pending', null, 0, 0, null, null, null, 999_998>
  'claim-sleeping': PoisonTargetProfileSeed<'sleeping', null, 1, 1, null, null, null, 999_998>
  'sweep-lost-launch': PoisonTargetProfileSeed<
    'running',
    'poison-worker',
    1,
    0,
    60_000,
    999_998,
    940_000,
    null
  >
  'sweep-claim-timeout': PoisonTargetProfileSeed<
    'running',
    'poison-worker',
    1,
    1,
    60_000,
    999_998,
    940_000,
    null
  >
}>

export type PoisonTargetProfile = keyof PoisonTargetProfileSeedRecord

export const POISON_TARGET_PROFILE_SEEDS = Object.freeze({
  'claim-pending': Object.freeze({
    state: 'pending',
    taskAttempts: 0,
    taskMaxAttempts: 5,
    taskInfraRetries: 0,
    runAttempt: 1,
    claimedBy: null,
    claimGen: 0,
    activatedGen: 0,
    runRelaunchCount: 0,
    leaseMs: null,
    claimExpiresAtMs: null,
    heartbeatAtMs: null,
    availableAtMs: 999_998,
  }),
  'claim-sleeping': Object.freeze({
    state: 'sleeping',
    taskAttempts: 0,
    taskMaxAttempts: 5,
    taskInfraRetries: 0,
    runAttempt: 1,
    claimedBy: null,
    claimGen: 1,
    activatedGen: 1,
    runRelaunchCount: 0,
    leaseMs: null,
    claimExpiresAtMs: null,
    heartbeatAtMs: null,
    availableAtMs: 999_998,
  }),
  'sweep-lost-launch': Object.freeze({
    state: 'running',
    taskAttempts: 0,
    taskMaxAttempts: 5,
    taskInfraRetries: 0,
    runAttempt: 1,
    claimedBy: TOKEN,
    claimGen: 1,
    activatedGen: 0,
    runRelaunchCount: 0,
    leaseMs: 60_000,
    claimExpiresAtMs: 999_998,
    heartbeatAtMs: 940_000,
    availableAtMs: null,
  }),
  'sweep-claim-timeout': Object.freeze({
    state: 'running',
    taskAttempts: 0,
    taskMaxAttempts: 5,
    taskInfraRetries: 0,
    runAttempt: 1,
    claimedBy: TOKEN,
    claimGen: 1,
    activatedGen: 1,
    runRelaunchCount: 0,
    leaseMs: 60_000,
    claimExpiresAtMs: 999_998,
    heartbeatAtMs: 940_000,
    availableAtMs: null,
  }),
} as const satisfies PoisonTargetProfileSeedRecord)

type CounterSeedOverrides = Readonly<
  Partial<{
    attempts: number
    maxAttempts: number
    infraRetries: number
    attempt: number
    claimGen: number
    activatedGen: number
    relaunchCount: number
  }>
>

export type PoisonUnreachableTargetReason =
  | 'counter-relation-needs-another-invalid-field'
  | 'generation-classification-needs-another-invalid-field'
  | 'transition-does-not-read-field'

export type PoisonTargetability =
  | { readonly kind: 'targetable'; readonly companions?: CounterSeedOverrides }
  | {
      readonly kind: 'unreachable'
      readonly reason: PoisonUnreachableTargetReason
    }

type TargetableCounterTargetability = Readonly<{ kind: 'targetable' }>
type UnreachableCounterTargetability<Reason extends PoisonUnreachableTargetReason> = Readonly<{
  kind: 'unreachable'
  reason: Reason
}>

export type PoisonCounterTargetabilityVector<
  Claim extends PoisonTargetability,
  LostLaunch extends PoisonTargetability,
  ClaimTimeout extends PoisonTargetability,
> = Readonly<{
  claim: Claim
  'sweep:lost-launch': LostLaunch
  'sweep:claim-timeout': ClaimTimeout
}>

type TargetableVector = PoisonCounterTargetabilityVector<
  TargetableCounterTargetability,
  TargetableCounterTargetability,
  TargetableCounterTargetability
>
type CounterRelationVector = PoisonCounterTargetabilityVector<
  UnreachableCounterTargetability<'counter-relation-needs-another-invalid-field'>,
  UnreachableCounterTargetability<'counter-relation-needs-another-invalid-field'>,
  UnreachableCounterTargetability<'counter-relation-needs-another-invalid-field'>
>
type GenerationVector = PoisonCounterTargetabilityVector<
  UnreachableCounterTargetability<'generation-classification-needs-another-invalid-field'>,
  UnreachableCounterTargetability<'generation-classification-needs-another-invalid-field'>,
  UnreachableCounterTargetability<'generation-classification-needs-another-invalid-field'>
>
type UnreadVector = PoisonCounterTargetabilityVector<
  UnreachableCounterTargetability<'transition-does-not-read-field'>,
  UnreachableCounterTargetability<'transition-does-not-read-field'>,
  UnreachableCounterTargetability<'transition-does-not-read-field'>
>
type TargetableTargetableGenerationVector = PoisonCounterTargetabilityVector<
  TargetableCounterTargetability,
  TargetableCounterTargetability,
  UnreachableCounterTargetability<'generation-classification-needs-another-invalid-field'>
>
export type GenerationGenerationTargetableVector = PoisonCounterTargetabilityVector<
  UnreachableCounterTargetability<'generation-classification-needs-another-invalid-field'>,
  UnreachableCounterTargetability<'generation-classification-needs-another-invalid-field'>,
  TargetableCounterTargetability
>

/**
 * Exact counter-boundary classification contract.
 *
 * This intentionally names both sides of every persisted counter. Adding a
 * persisted field therefore cannot silently inherit a default classification:
 * the direct lookup below stops compiling until its two vectors are declared.
 */
export type PoisonCounterTargetabilityRecord = Readonly<{
  'task-attempts/upper': CounterRelationVector
  'task-attempts/lower': TargetableVector
  'task-max-attempts/upper': TargetableVector
  'task-max-attempts/lower': CounterRelationVector
  'task-infra-retries/upper': TargetableVector
  'task-infra-retries/lower': TargetableVector
  'run-attempt/upper': CounterRelationVector
  'run-attempt/lower': CounterRelationVector
  'run-claim-gen/upper': TargetableTargetableGenerationVector
  'run-claim-gen/lower': GenerationVector
  'run-activated-gen/upper': GenerationVector
  'run-activated-gen/lower': TargetableTargetableGenerationVector
  'run-relaunch-count/upper': TargetableVector
  'run-relaunch-count/lower': TargetableVector
  'checkpoint-owner-attempt/upper': UnreadVector
  'checkpoint-owner-attempt/lower': UnreadVector
}>

export type PoisonRelationalTargetRecord = {
  readonly 'attempts/at-max-with-live-run': TargetableVector
  readonly 'accounting/below-top-minus-one': TargetableVector
  readonly 'accounting/live-run-not-next': TargetableVector
  readonly 'counter-fractional/task-max-attempts': TargetableVector
  readonly 'counter-fractional/run-relaunch-count': TargetableVector
}

export interface CounterBoundaryTarget {
  readonly fieldId: PersistedCounterFieldId
  readonly side: 'upper' | 'lower'
  readonly arms: Readonly<Record<PoisonTargetArm, PoisonTargetability>>
}

export interface PoisonWitness {
  id: string
  covers: readonly EngineInvariantConditionId[]
  statements: readonly SqlStatement[]
  storageCorruption?: StorageCorruption
  inertLive?: true
  counterBoundary?: CounterBoundaryTarget
  targetNonExactField?: PersistedCounterFieldId
}

const sql = (
  text: string,
  args: ReadonlyArray<string | number | bigint | Uint8Array | null> = [],
): SqlStatement => ({ sql: text, args })

const taskState = (state: string): SqlStatement =>
  sql(`UPDATE tasks SET state = ? WHERE task_id = ?`, [state, TASK])

/** The completed payload a completed poison task needs, so only its covered conditions fire. */
const completedPayload = (): SqlStatement =>
  sql(`UPDATE tasks SET completed_payload = '{"poison":true}' WHERE task_id = ?`, [TASK])

const runState = (state: string): SqlStatement =>
  sql(
    `UPDATE runs SET state = ?, claimed_by = ?, claim_expires_at_ms = ?
     WHERE run_id = ?`,
    [state, state === 'running' ? TOKEN : null, state === 'running' ? NOW + 60_000 : null, RUN],
  )

function park(
  options: {
    taskId?: string
    queue?: string
    runState?: 'sleeping' | 'running'
    wakeEvent?: string | null
    runAt?: number | null
    waitAt?: number | null
    status?: 'waiting' | 'delivered'
  } = {},
): readonly SqlStatement[] {
  const state = options.runState ?? 'sleeping'
  const wakeEvent = options.wakeEvent === undefined ? EVENT : options.wakeEvent
  const runAt = options.runAt ?? null
  const waitAt = options.waitAt ?? null
  return [
    taskState(state),
    sql(
      `UPDATE runs SET state = ?, claimed_by = ?, claim_expires_at_ms = ?,
         available_at_ms = ?, wake_event = ?, wake_step = ?
       WHERE run_id = ?`,
      [
        state,
        state === 'running' ? TOKEN : null,
        state === 'running' ? NOW + 60_000 : null,
        runAt,
        wakeEvent,
        STEP,
        RUN,
      ],
    ),
    sql(
      `INSERT INTO waits
         (run_id, step_name, queue, task_id, event_name, status, timeout_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        RUN,
        STEP,
        options.queue ?? Q,
        options.taskId ?? TASK,
        EVENT,
        options.status ?? 'waiting',
        waitAt,
        NOW,
      ],
    ),
  ]
}

const checkpoint = (
  taskId: string,
  queue: string,
  ownerRunId: string,
  updatedAt: string | number = NOW,
  ownerAttempt: string | number = 1,
): SqlStatement =>
  sql(
    `INSERT INTO checkpoints
       (task_id, checkpoint_name, queue, state, status, owner_run_id, owner_attempt, updated_at_ms)
     VALUES (?, 'poison-checkpoint', ?, '{}', 'committed', ?, ?, ?)`,
    [taskId, queue, ownerRunId, ownerAttempt, updatedAt],
  )

const TARGETABLE_COUNTER_TARGETABILITY = Object.freeze({ kind: 'targetable' as const })
const COUNTER_RELATION_TARGETABILITY = Object.freeze({
  kind: 'unreachable' as const,
  reason: 'counter-relation-needs-another-invalid-field' as const,
})
const GENERATION_TARGETABILITY = Object.freeze({
  kind: 'unreachable' as const,
  reason: 'generation-classification-needs-another-invalid-field' as const,
})
const UNREAD_TARGETABILITY = Object.freeze({
  kind: 'unreachable' as const,
  reason: 'transition-does-not-read-field' as const,
})

const COUNTER_TARGETABILITY = Object.freeze({
  'task-attempts/upper': Object.freeze({
    claim: COUNTER_RELATION_TARGETABILITY,
    'sweep:lost-launch': COUNTER_RELATION_TARGETABILITY,
    'sweep:claim-timeout': COUNTER_RELATION_TARGETABILITY,
  }),
  'task-attempts/lower': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': TARGETABLE_COUNTER_TARGETABILITY,
  }),
  'task-max-attempts/upper': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': TARGETABLE_COUNTER_TARGETABILITY,
  }),
  'task-max-attempts/lower': Object.freeze({
    claim: COUNTER_RELATION_TARGETABILITY,
    'sweep:lost-launch': COUNTER_RELATION_TARGETABILITY,
    'sweep:claim-timeout': COUNTER_RELATION_TARGETABILITY,
  }),
  'task-infra-retries/upper': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': TARGETABLE_COUNTER_TARGETABILITY,
  }),
  'task-infra-retries/lower': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': TARGETABLE_COUNTER_TARGETABILITY,
  }),
  'run-attempt/upper': Object.freeze({
    claim: COUNTER_RELATION_TARGETABILITY,
    'sweep:lost-launch': COUNTER_RELATION_TARGETABILITY,
    'sweep:claim-timeout': COUNTER_RELATION_TARGETABILITY,
  }),
  'run-attempt/lower': Object.freeze({
    claim: COUNTER_RELATION_TARGETABILITY,
    'sweep:lost-launch': COUNTER_RELATION_TARGETABILITY,
    'sweep:claim-timeout': COUNTER_RELATION_TARGETABILITY,
  }),
  'run-claim-gen/upper': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': GENERATION_TARGETABILITY,
  }),
  'run-claim-gen/lower': Object.freeze({
    claim: GENERATION_TARGETABILITY,
    'sweep:lost-launch': GENERATION_TARGETABILITY,
    'sweep:claim-timeout': GENERATION_TARGETABILITY,
  }),
  'run-activated-gen/upper': Object.freeze({
    claim: GENERATION_TARGETABILITY,
    'sweep:lost-launch': GENERATION_TARGETABILITY,
    'sweep:claim-timeout': GENERATION_TARGETABILITY,
  }),
  'run-activated-gen/lower': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': GENERATION_TARGETABILITY,
  }),
  'run-relaunch-count/upper': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': TARGETABLE_COUNTER_TARGETABILITY,
  }),
  'run-relaunch-count/lower': Object.freeze({
    claim: TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:lost-launch': TARGETABLE_COUNTER_TARGETABILITY,
    'sweep:claim-timeout': TARGETABLE_COUNTER_TARGETABILITY,
  }),
  'checkpoint-owner-attempt/upper': Object.freeze({
    claim: UNREAD_TARGETABILITY,
    'sweep:lost-launch': UNREAD_TARGETABILITY,
    'sweep:claim-timeout': UNREAD_TARGETABILITY,
  }),
  'checkpoint-owner-attempt/lower': Object.freeze({
    claim: UNREAD_TARGETABILITY,
    'sweep:lost-launch': UNREAD_TARGETABILITY,
    'sweep:claim-timeout': UNREAD_TARGETABILITY,
  }),
} as const satisfies PoisonCounterTargetabilityRecord)

const ALL_TARGET_ARMS = Object.freeze({
  claim: Object.freeze({ kind: 'targetable' as const }),
  'sweep:lost-launch': Object.freeze({ kind: 'targetable' as const }),
  'sweep:claim-timeout': Object.freeze({ kind: 'targetable' as const }),
})

export const POISON_RELATIONAL_TARGETS = Object.freeze({
  'attempts/at-max-with-live-run': ALL_TARGET_ARMS,
  'accounting/below-top-minus-one': ALL_TARGET_ARMS,
  'accounting/live-run-not-next': ALL_TARGET_ARMS,
  'counter-fractional/task-max-attempts': ALL_TARGET_ARMS,
  'counter-fractional/run-relaunch-count': ALL_TARGET_ARMS,
} as const satisfies PoisonRelationalTargetRecord)

function counterCompanions(
  fieldId: PersistedCounterFieldId,
  side: 'upper' | 'lower',
): CounterSeedOverrides | undefined {
  const key = `${fieldId}/${side}`
  if (key === 'task-attempts/lower') return Object.freeze({ infraRetries: 1 })
  if (key === 'task-infra-retries/lower') return Object.freeze({ attempts: 1 })
  if (key === 'task-infra-retries/upper') {
    return Object.freeze({
      attempt: PERSISTED_INTEGER_BOUNDS.tasks.infra_retries.max + 2,
    })
  }
  return undefined
}

function counterBoundaryTarget(
  fieldId: PersistedCounterFieldId,
  side: 'upper' | 'lower',
): CounterBoundaryTarget {
  const arms = COUNTER_TARGETABILITY[`${fieldId}/${side}`]
  const companions = counterCompanions(fieldId, side)
  const mergeCompanions = (targetability: PoisonTargetability): PoisonTargetability =>
    targetability.kind === 'targetable' && companions !== undefined
      ? Object.freeze({ ...targetability, companions })
      : targetability
  return Object.freeze({
    fieldId,
    side,
    arms: Object.freeze({
      claim: mergeCompanions(arms.claim),
      'sweep:lost-launch': mergeCompanions(arms['sweep:lost-launch']),
      'sweep:claim-timeout': mergeCompanions(arms['sweep:claim-timeout']),
    }),
  })
}

function counterValueStatement(
  field: PersistedCounterFieldDescriptor,
  value: number,
): SqlStatement {
  if (field.table === 'checkpoints') return checkpoint(TASK, Q, RUN, NOW, value)
  const identityColumn = field.table === 'tasks' ? 'task_id' : 'run_id'
  const identity = field.table === 'tasks' ? TASK : RUN
  return sql(`UPDATE ${field.table} SET ${field.column} = ? WHERE ${identityColumn} = ?`, [
    value,
    identity,
  ])
}

function persistedCounterField(id: PersistedCounterFieldId): PersistedCounterFieldDescriptor {
  const field = PERSISTED_COUNTER_FIELDS.find((candidate) => candidate.id === id)
  if (!field) throw new Error(`missing persisted counter field '${id}'`)
  return field
}

function counterStorageCorruption(
  field: PersistedCounterFieldDescriptor,
  invalidRepresentation: 'fractional-real' | 'non-integer' = 'non-integer',
): StorageCorruption {
  if (field.table === 'tasks') {
    return {
      table: 'tasks',
      taskId: TASK,
      column: field.column,
      invalidRepresentation,
    }
  }
  if (field.table === 'runs') {
    return {
      table: 'runs',
      runId: RUN,
      column: field.column,
      invalidRepresentation,
    }
  }
  return {
    table: 'checkpoints',
    taskId: TASK,
    checkpointName: 'poison-checkpoint',
    column: field.column,
    invalidRepresentation,
  }
}

function temporalSeedStatements(field: PersistedTemporalFieldDescriptor): readonly SqlStatement[] {
  return field.table === 'checkpoints' ? [checkpoint(TASK, Q, RUN)] : []
}

function temporalValueStatement(
  field: PersistedTemporalFieldDescriptor,
  value: number,
): SqlStatement {
  switch (field.table) {
    case 'tasks':
      return sql(`UPDATE tasks SET ${field.column} = ? WHERE task_id = ?`, [value, TASK])
    case 'runs':
      return sql(`UPDATE runs SET ${field.column} = ? WHERE run_id = ?`, [value, RUN])
    case 'checkpoints':
      return checkpoint(TASK, Q, RUN, value)
    case 'events':
      return sql(`UPDATE events SET ${field.column} = ? WHERE queue = ? AND event_name = ?`, [
        value,
        Q,
        PROTECTED_EVENT,
      ])
    case 'waits':
      return sql(`UPDATE waits SET ${field.column} = ? WHERE run_id = ? AND step_name = ?`, [
        value,
        PROTECTED_RUN,
        PROTECTED_STEP,
      ])
    case 'drivers':
      return sql(`UPDATE drivers SET ${field.column} = ? WHERE queue = ? AND driver_id = ?`, [
        value,
        Q,
        PROTECTED_DRIVER,
      ])
  }
}

function temporalStorageCorruption(field: PersistedTemporalFieldDescriptor): StorageCorruption {
  switch (field.table) {
    case 'tasks':
      return {
        table: 'tasks',
        taskId: TASK,
        column: field.column,
        invalidRepresentation: 'non-integer',
      }
    case 'runs':
      return {
        table: 'runs',
        runId: RUN,
        column: field.column,
        invalidRepresentation: 'non-integer',
      }
    case 'checkpoints':
      return {
        table: 'checkpoints',
        taskId: TASK,
        checkpointName: 'poison-checkpoint',
        column: field.column,
        invalidRepresentation: 'non-integer',
      }
    case 'events':
      return {
        table: 'events',
        queue: Q,
        eventName: PROTECTED_EVENT,
        column: field.column,
        invalidRepresentation: 'non-integer',
      }
    case 'waits':
      return {
        table: 'waits',
        runId: PROTECTED_RUN,
        stepName: PROTECTED_STEP,
        column: field.column,
        invalidRepresentation: 'non-integer',
      }
    case 'drivers':
      return {
        table: 'drivers',
        queue: Q,
        driverId: PROTECTED_DRIVER,
        column: field.column,
        invalidRepresentation: 'non-integer',
      }
  }
}

const event = (payload: string | null): SqlStatement =>
  sql(
    `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
     VALUES (?, ?, ?, ?)`,
    [Q, EVENT, payload, NOW],
  )

/**
 * Atomic witnesses, not one happy-path example per checker. OR arms and
 * NULL-safe comparisons get separate representatives so a checker cannot
 * claim a broader property than its generated corruption surface exercises.
 */
export const POISON_WITNESSES: readonly PoisonWitness[] = [
  {
    id: 'terminal-task/live-running-run',
    covers: ['terminal-task/live-run', 'mirror/running-run-task-not-running'],
    statements: [taskState('completed'), completedPayload()],
  },
  {
    id: 'lease/running-owner-null',
    covers: ['lease/running-owner-null'],
    statements: [sql(`UPDATE runs SET claimed_by = NULL WHERE run_id = ?`, [RUN])],
    inertLive: true,
  },
  {
    id: 'mirror/running-task-no-live-run',
    covers: ['mirror/running-task-no-live-run', 'cardinality/live-task-zero-runs'],
    statements: [sql(`DELETE FROM runs WHERE run_id = ?`, [RUN])],
    inertLive: true,
  },
  {
    id: 'cardinality/two-live-runs',
    covers: ['cardinality/multiple-live-runs', 'cardinality/live-task-multiple-runs'],
    statements: [
      taskState('pending'),
      sql(`UPDATE tasks SET infra_retries = 1 WHERE task_id = ?`, [TASK]),
      sql(
        `UPDATE runs SET state = 'pending', claimed_by = NULL, claim_expires_at_ms = NULL,
           available_at_ms = ? WHERE run_id = ?`,
        [NOW, RUN],
      ),
      sql(
        `INSERT INTO runs
         (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
         VALUES (?, ?, ?, 2, 'pending', ?, ?)`,
        [RUN_2, Q, TASK, NOW, NOW],
      ),
    ],
    inertLive: true,
  },
  {
    id: 'mirror/live-state-mismatch',
    covers: ['mirror/live-state-mismatch'],
    statements: [
      taskState('pending'),
      sql(
        `UPDATE runs SET state = 'sleeping', claimed_by = NULL, claim_expires_at_ms = NULL,
           available_at_ms = ? WHERE run_id = ?`,
        [NOW + 60_000, RUN],
      ),
    ],
    inertLive: true,
  },
  {
    id: 'ownership/run-task-missing',
    covers: ['ownership/run-task-missing'],
    statements: [sql(`DELETE FROM tasks WHERE task_id = ?`, [TASK])],
    inertLive: true,
  },
  {
    id: 'ownership/run-task-queue-mismatch',
    covers: ['ownership/run-task-queue-mismatch'],
    statements: [sql(`UPDATE runs SET queue = ? WHERE run_id = ?`, [OTHER_Q, RUN])],
    inertLive: true,
  },
  {
    id: 'attempts/over-max',
    covers: ['attempts/over-max'],
    statements: [
      sql(`UPDATE tasks SET attempts = 4, max_attempts = 3 WHERE task_id = ?`, [TASK]),
      sql(`UPDATE runs SET attempt = 4 WHERE run_id = ?`, [RUN]),
    ],
  },
  {
    id: 'attempts/at-max-with-live-run',
    covers: ['attempts/at-max-with-live-run'],
    statements: [
      sql(`UPDATE tasks SET attempts = max_attempts WHERE task_id = ?`, [TASK]),
      sql(`UPDATE runs SET attempt = 6 WHERE run_id = ?`, [RUN]),
    ],
  },
  {
    id: 'task-outcome/completed-without-payload',
    covers: ['task-outcome/completed-without-payload'],
    statements: [taskState('completed'), runState('completed')],
  },
  {
    id: 'task-outcome/payload-on-other-state',
    covers: ['task-outcome/payload-on-other-state'],
    statements: [
      sql(`UPDATE tasks SET completed_payload = '{"forged":true}' WHERE task_id = ?`, [TASK]),
    ],
  },
  {
    id: 'task-outcome/failure-without-reason',
    covers: ['task-outcome/failure-without-reason'],
    statements: [taskState('cancelled'), runState('cancelled')],
  },
  {
    id: 'task-outcome/failed-with-payload-without-reason',
    covers: ['task-outcome/payload-on-other-state', 'task-outcome/failure-without-reason'],
    statements: [taskState('failed'), runState('failed'), completedPayload()],
  },
  {
    id: 'task-outcome/reason-on-other-state',
    covers: ['task-outcome/reason-on-other-state'],
    statements: [
      sql(`UPDATE tasks SET failure_reason = '{"name":"Forged"}' WHERE task_id = ?`, [TASK]),
    ],
  },
  {
    id: 'accounting/above-top',
    covers: ['accounting/above-top'],
    statements: [sql(`UPDATE tasks SET attempts = 2 WHERE task_id = ?`, [TASK])],
  },
  {
    id: 'accounting/below-top-minus-one',
    covers: ['accounting/below-top-minus-one'],
    statements: [
      sql(
        `INSERT INTO runs
           (run_id, queue, task_id, attempt, state, created_at_ms)
         VALUES (?, ?, ?, 3, 'failed', ?)`,
        [RUN_2, Q, TASK, NOW],
      ),
    ],
  },
  {
    id: 'accounting/live-run-not-next',
    covers: ['accounting/live-run-not-next'],
    statements: [sql(`UPDATE tasks SET attempts = 1 WHERE task_id = ?`, [TASK])],
  },
  {
    // A failed task at its full budget whose top run no counter recorded: the
    // accounting band holds, but a revival would charge one past the budget.
    id: 'accounting/failed-charge-past-budget',
    covers: ['accounting/failed-charge-past-budget'],
    statements: [
      sql(
        `UPDATE tasks SET state = 'failed', failure_reason = '{"name":"Forged"}',
           attempts = max_attempts WHERE task_id = ?`,
        [TASK],
      ),
      sql(`UPDATE runs SET state = 'failed', attempt = 6 WHERE run_id = ?`, [RUN]),
    ],
  },
  {
    id: 'checkpoint/task-mismatch',
    covers: ['checkpoint/task-mismatch'],
    statements: [checkpoint(CANARY_TASK, Q, RUN)],
  },
  {
    id: 'checkpoint/queue-mismatch',
    covers: ['checkpoint/queue-mismatch'],
    statements: [checkpoint(TASK, OTHER_Q, RUN)],
  },
  {
    id: 'checkpoint/owner-missing',
    covers: ['checkpoint/owner-missing'],
    statements: [checkpoint(TASK, Q, GHOST_RUN)],
  },
  {
    id: 'checkpoint/owner-attempt-mismatch',
    covers: ['checkpoint/owner-attempt-mismatch'],
    statements: [checkpoint(TASK, Q, RUN, NOW, 2)],
  },
  {
    id: 'wait/dead-run',
    covers: ['wait/dead-run'],
    statements: [
      taskState('completed'),
      completedPayload(),
      runState('completed'),
      sql(
        `INSERT INTO waits
           (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 'delivered', ?)`,
        [RUN, STEP, Q, TASK, EVENT, NOW],
      ),
    ],
  },
  {
    id: 'wait/run-missing',
    covers: ['wait/run-missing'],
    statements: [
      sql(
        `INSERT INTO waits
           (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 'delivered', ?)`,
        [GHOST_RUN, STEP, Q, TASK, EVENT, NOW],
      ),
    ],
  },
  {
    id: 'wait/task-mismatch',
    covers: ['wait/task-mismatch'],
    statements: park({ taskId: CANARY_TASK }),
  },
  {
    id: 'wait/queue-mismatch',
    covers: ['wait/queue-mismatch'],
    statements: park({ queue: OTHER_Q }),
  },
  {
    id: 'wait/fired-event',
    covers: ['wait/fired-event'],
    statements: [...park(), event('{"ok":true}')],
  },
  {
    id: 'wait/run-not-sleeping',
    covers: ['wait/run-not-sleeping'],
    statements: park({ runState: 'running' }),
  },
  {
    id: 'wait/wake-name-null',
    covers: ['wait/wake-name-null'],
    statements: park({ wakeEvent: null }),
  },
  {
    id: 'wait/wake-name-different',
    covers: ['wait/wake-name-different'],
    statements: park({ wakeEvent: 'other-event' }),
  },
  {
    id: 'wait/untimed-wait-timed-run',
    covers: ['wait/untimed-wait-timed-run'],
    statements: park({ runAt: NOW + 30_000, waitAt: null }),
  },
  {
    id: 'wait/timed-wait-untimed-run',
    covers: ['wait/timed-wait-untimed-run'],
    statements: park({ runAt: null, waitAt: NOW + 30_000 }),
  },
  {
    id: 'wait/deadlines-differ',
    covers: ['wait/deadlines-differ'],
    statements: park({ runAt: NOW + 30_000, waitAt: NOW + 30_001 }),
  },
  {
    id: 'payload/event-missing',
    covers: ['payload/event-missing'],
    statements: [
      taskState('pending'),
      sql(
        `UPDATE runs SET state = 'pending', claimed_by = NULL, claim_expires_at_ms = NULL,
           available_at_ms = ?, wake_event = ?, event_payload = '{"got":1}'
         WHERE run_id = ?`,
        [NOW, 'missing-poison-event', RUN],
      ),
    ],
  },
  {
    id: 'payload/stored-payload-null',
    covers: ['payload/stored-payload-null'],
    statements: [
      taskState('pending'),
      sql(
        `UPDATE runs SET state = 'pending', claimed_by = NULL, claim_expires_at_ms = NULL,
           available_at_ms = ?, wake_event = ?, event_payload = '{"got":1}'
         WHERE run_id = ?`,
        [NOW, EVENT, RUN],
      ),
      event(null),
    ],
  },
  {
    id: 'payload/stored-payload-different',
    covers: ['payload/stored-payload-different'],
    statements: [
      taskState('pending'),
      sql(
        `UPDATE runs SET state = 'pending', claimed_by = NULL, claim_expires_at_ms = NULL,
           available_at_ms = ?, wake_event = ?, event_payload = '{"got":1}'
         WHERE run_id = ?`,
        [NOW, EVENT, RUN],
      ),
      event('{"got":2}'),
    ],
  },
  // Three generated witnesses per temporal descriptor prove the full
  // storage/lower/upper surface. The duplicated hand-maintained timestamp
  // lists that previously covered only eight fields no longer exist.
  ...PERSISTED_TEMPORAL_FIELDS.map(
    (field): PoisonWitness => ({
      id: `temporal/${field.id}`,
      covers: [`temporal/${field.id}` as EngineInvariantConditionId],
      statements: temporalSeedStatements(field),
      storageCorruption: temporalStorageCorruption(field),
    }),
  ),
  ...PERSISTED_TEMPORAL_FIELDS.map(
    (field): PoisonWitness => ({
      id: `temporal-bound-lower/${field.id}`,
      covers: [`temporal-bound/${field.id}` as EngineInvariantConditionId],
      statements: [temporalValueStatement(field, field.bounds.min - 1)],
    }),
  ),
  ...PERSISTED_TEMPORAL_FIELDS.map(
    (field): PoisonWitness => ({
      id: `temporal-bound/${field.id}`,
      covers: [`temporal-bound/${field.id}` as EngineInvariantConditionId],
      statements: [temporalValueStatement(field, field.bounds.max + 1)],
    }),
  ),
  ...PERSISTED_COUNTER_FIELDS.map(
    (field): PoisonWitness => ({
      id: `counter/${field.id}`,
      covers: [`counter/${field.id}` as EngineInvariantConditionId],
      statements: field.table === 'checkpoints' ? [checkpoint(TASK, Q, RUN)] : [],
      storageCorruption: counterStorageCorruption(field),
    }),
  ),
  ...PERSISTED_COUNTER_FIELDS.flatMap((field): PoisonWitness[] => {
    if (field.id !== 'task-max-attempts' && field.id !== 'run-relaunch-count') return []
    return [
      {
        id: `counter-fractional/${field.id}`,
        covers: [`counter/${field.id}`],
        statements: [],
        storageCorruption: counterStorageCorruption(field, 'fractional-real'),
        targetNonExactField: field.id,
      },
    ]
  }),
  ...PERSISTED_COUNTER_FIELDS.map(
    (field): PoisonWitness => ({
      id: `counter-bound/${field.id}`,
      covers: [`counter-bound/${field.id}` as EngineInvariantConditionId],
      statements: [counterValueStatement(field, field.bounds.max + 1)],
      counterBoundary: counterBoundaryTarget(field.id, 'upper'),
    }),
  ),
  ...PERSISTED_COUNTER_FIELDS.map(
    (field): PoisonWitness => ({
      id: `counter-bound-lower/${field.id}`,
      covers: [`counter-bound/${field.id}` as EngineInvariantConditionId],
      statements: [counterValueStatement(field, field.bounds.min - 1)],
      counterBoundary: counterBoundaryTarget(field.id, 'lower'),
    }),
  ),
  {
    id: 'provenance/stamp-without-instant',
    covers: ['provenance/stamp-without-instant'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = 'poison:task', fence_at_ms = NULL WHERE task_id = ?`, [
        TASK,
      ]),
    ],
  },
  {
    id: 'provenance/instant-without-stamp',
    covers: ['provenance/instant-without-stamp'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = NULL, fence_at_ms = ? WHERE task_id = ?`, [NOW, TASK]),
    ],
  },
  {
    id: 'provenance/instant-not-integer',
    covers: ['provenance/instant-not-integer'],
    statements: [
      sql(
        `UPDATE tasks SET fence_stamp = 'poison:task', fence_at_ms = ?
         WHERE task_id = ?`,
        [NOW, TASK],
      ),
    ],
    storageCorruption: {
      table: 'tasks',
      taskId: TASK,
      column: 'fence_at_ms',
      invalidRepresentation: 'non-integer',
    },
  },
  {
    id: 'provenance/stamp-not-text',
    covers: ['provenance/stamp-not-text'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = 'poison:task', fence_at_ms = ? WHERE task_id = ?`, [
        NOW,
        TASK,
      ]),
    ],
    storageCorruption: {
      table: 'tasks',
      taskId: TASK,
      column: 'fence_stamp',
      invalidRepresentation: 'non-text',
    },
  },
  {
    id: 'provenance/no-separator',
    covers: ['provenance/no-separator'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = 'poison', fence_at_ms = ? WHERE task_id = ?`, [
        NOW,
        TASK,
      ]),
    ],
  },
  {
    id: 'provenance/empty-seed',
    covers: ['provenance/empty-seed'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = ':task', fence_at_ms = ? WHERE task_id = ?`, [NOW, TASK]),
    ],
  },
  {
    id: 'provenance/empty-statement',
    covers: ['provenance/empty-statement'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = 'poison:', fence_at_ms = ? WHERE task_id = ?`, [
        NOW,
        TASK,
      ]),
    ],
  },
  {
    id: 'provenance/statement-name-invalid',
    covers: ['provenance/statement-name-invalid'],
    statements: [
      sql(
        `UPDATE tasks SET fence_stamp = 'poison:not a generated name', fence_at_ms = ?
         WHERE task_id = ?`,
        [NOW, TASK],
      ),
    ],
  },
  {
    id: 'provenance/one-seed-two-instants',
    covers: ['provenance/one-seed-two-instants'],
    statements: [
      sql(`UPDATE tasks SET fence_stamp = 'poison:a', fence_at_ms = ? WHERE task_id = ?`, [
        NOW,
        TASK,
      ]),
      sql(`UPDATE runs SET fence_stamp = 'poison:b', fence_at_ms = ? WHERE run_id = ?`, [
        NOW + 1,
        RUN,
      ]),
    ],
  },
  {
    id: 'generation/activated-after-claim',
    covers: ['generation/activated-after-claim'],
    statements: [sql(`UPDATE runs SET activated_gen = claim_gen + 1 WHERE run_id = ?`, [RUN])],
  },
  {
    id: 'generation/negative-claim',
    covers: ['generation/negative-claim'],
    statements: [sql(`UPDATE runs SET claim_gen = -1, activated_gen = -1 WHERE run_id = ?`, [RUN])],
  },
  {
    id: 'generation/negative-relaunch',
    covers: ['generation/negative-relaunch'],
    statements: [sql(`UPDATE runs SET relaunch_count = -1 WHERE run_id = ?`, [RUN])],
  },
  {
    id: 'generation/negative-attempts',
    covers: ['generation/negative-attempts'],
    statements: [
      sql(`UPDATE tasks SET attempts = -1, infra_retries = 1 WHERE task_id = ?`, [TASK]),
    ],
  },
  {
    id: 'generation/negative-infra-retries',
    covers: ['generation/negative-infra-retries'],
    statements: [
      sql(`UPDATE tasks SET attempts = 1, infra_retries = -1 WHERE task_id = ?`, [TASK]),
    ],
  },
  {
    // A name past the width, as an older build could leave one on libSQL and PostgreSQL.
    // MySQL's column refuses the write, so there the witness is structurally rejected.
    id: 'identifier/over-width',
    covers: ['identifier/over-width'],
    statements: [],
    storageCorruption: {
      table: 'tasks',
      taskId: TASK,
      column: 'idempotency_key',
      invalidRepresentation: 'over-width',
    },
  },
]

export const POISON_WITNESS_COUNT = POISON_WITNESSES.length
/** One source of truth: every classified write label is automatically enrolled. */
export const POISON_WRITE_LABELS = MATRIX_WRITE_LABELS

export interface PoisonTargetCase {
  readonly id: string
  readonly label: PoisonTargetArm
  readonly profile: PoisonTargetProfile
  readonly witness: PoisonWitness
  readonly companions: CounterSeedOverrides
}

export interface UnreachablePoisonTarget {
  readonly id: string
  readonly witness: string
  readonly arm: PoisonTargetArm
  readonly reason: Extract<PoisonTargetability, { kind: 'unreachable' }>['reason']
}

const profilesForArm = (arm: PoisonTargetArm): readonly PoisonTargetProfile[] =>
  arm === 'claim'
    ? ['claim-pending', 'claim-sleeping']
    : [arm === 'sweep:lost-launch' ? 'sweep-lost-launch' : 'sweep-claim-timeout']

const targetCases: PoisonTargetCase[] = []
const unreachableTargets: UnreachablePoisonTarget[] = []
const enrollTarget = (
  witness: PoisonWitness,
  targetArms: Readonly<Record<PoisonTargetArm, PoisonTargetability>>,
): void => {
  for (const arm of ['claim', 'sweep:lost-launch', 'sweep:claim-timeout'] as const) {
    const targetability = targetArms[arm]
    if (targetability.kind === 'unreachable') {
      unreachableTargets.push(
        Object.freeze({
          id: `${witness.id}/${arm}`,
          witness: witness.id,
          arm,
          reason: targetability.reason,
        }),
      )
      continue
    }
    for (const profile of profilesForArm(arm)) {
      targetCases.push(
        Object.freeze({
          id: `${witness.id}/${profile}`,
          label: arm,
          profile,
          witness,
          companions: targetability.companions ?? Object.freeze({}),
        }),
      )
    }
  }
}

const requiredPoisonWitness = (id: string): PoisonWitness => {
  for (const witness of POISON_WITNESSES) {
    if (witness.id === id) return witness
  }
  throw new Error(`missing poison witness ${id}`)
}

export type PoisonAggregateWitnessId = 'accounting/live-run-not-next'

/**
 * Witnesses whose invariant-firing proof is owned by one class-altitude
 * aggregate. Their transition cases still run through the normal matrix, but
 * they do not each re-assert the same precondition.
 */
export const POISON_AGGREGATE_WITNESSES = Object.freeze({
  'accounting/live-run-not-next': 'accounting/live-run-not-next',
} as const satisfies Readonly<{ [Id in PoisonAggregateWitnessId]: Id }>)

const aggregateOwnsWitness = (
  witness: PoisonWitness,
): witness is PoisonWitness & { readonly id: PoisonAggregateWitnessId } =>
  Object.prototype.hasOwnProperty.call(POISON_AGGREGATE_WITNESSES, witness.id)

for (const [witnessId, targetArms] of Object.entries(POISON_RELATIONAL_TARGETS)) {
  enrollTarget(requiredPoisonWitness(witnessId), targetArms)
}
for (const witness of POISON_WITNESSES) {
  if (witness.counterBoundary) enrollTarget(witness, witness.counterBoundary.arms)
}

export const POISON_TARGET_CASES: readonly PoisonTargetCase[] = Object.freeze(targetCases)
export const POISON_UNREACHABLE_TARGETS: readonly UnreachablePoisonTarget[] =
  Object.freeze(unreachableTargets)

export function uncoveredConditionIds(
  witnesses: readonly Pick<PoisonWitness, 'covers'>[] = POISON_WITNESSES,
  conditionIds: readonly string[] = ENGINE_INVARIANT_CONDITIONS.map((condition) => condition.id),
): string[] {
  const covered = new Set(witnesses.flatMap((witness) => witness.covers))
  return conditionIds.filter(
    (conditionId) => !covered.has(conditionId as EngineInvariantConditionId),
  )
}

export function unknownCoveredConditionIds(
  witnesses: readonly Pick<PoisonWitness, 'covers'>[] = POISON_WITNESSES,
  conditionIds: readonly string[] = ENGINE_INVARIANT_CONDITIONS.map((condition) => condition.id),
): string[] {
  const known = new Set(conditionIds)
  return [
    ...new Set(witnesses.flatMap((witness) => witness.covers).filter((id) => !known.has(id))),
  ].sort()
}

export function duplicatePoisonWitnessIds(): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const witness of POISON_WITNESSES) {
    if (seen.has(witness.id)) duplicates.add(witness.id)
    seen.add(witness.id)
  }
  return [...duplicates].sort()
}

interface RecordedCall {
  label: string
  mode: SqlBatchMode
  changedState: boolean
}

class RecordingExecutor implements SqlExecutor {
  readonly calls: RecordedCall[] = []
  constructor(private readonly real: SqlExecutor) {}

  get labels(): string[] {
    return this.calls.map((call) => call.label)
  }

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    control: SqlBatchControl = 'write',
  ): Promise<SqlResult[]> {
    const mode = sqlBatchMode(control)
    const call: RecordedCall = { label, mode, changedState: false }
    this.calls.push(call)
    const before = mode === 'write' ? await snapshot(this.real) : undefined
    const results = await this.real.batch(label, statements, control)
    if (before !== undefined) {
      call.changedState = !same(before, await snapshot(this.real))
    }
    return results
  }

  changedDurableState(label: string): boolean {
    return this.calls.some(
      (call) => call.label === label && call.mode === 'write' && call.changedState,
    )
  }
}

const SNAPSHOT_TABLES = [
  ['tasks', 'task_id', ['task_id', 'queue']],
  ['runs', 'run_id', ['run_id', 'queue', 'task_id', 'attempt']],
  [
    'checkpoints',
    'task_id, checkpoint_name',
    ['task_id', 'checkpoint_name', 'queue', 'owner_run_id', 'owner_attempt'],
  ],
  ['events', 'queue, event_name', ['queue', 'event_name']],
  ['waits', 'run_id, step_name', ['run_id', 'step_name', 'queue', 'task_id', 'event_name']],
  ['drivers', 'queue, driver_id', ['queue', 'driver_id']],
] as const

type SnapshotTable = (typeof SNAPSHOT_TABLES)[number][0]
export type ProtocolSnapshot = Record<SnapshotTable, readonly SqlRow[]>
const RELATIONSHIP_COLUMNS = {} as Record<SnapshotTable, readonly string[]>
for (const [table, , columns] of SNAPSHOT_TABLES) {
  RELATIONSHIP_COLUMNS[table] = columns
}

async function snapshot(raw: SqlExecutor): Promise<ProtocolSnapshot> {
  const results = await raw.batch(
    'poison:snapshot',
    SNAPSHOT_TABLES.map(([table, orderBy]) => sql(`SELECT * FROM ${table} ORDER BY ${orderBy}`)),
    'read',
  )
  if (results.length !== SNAPSHOT_TABLES.length) {
    throw new Error(
      `poison snapshot result count mismatch: expected ${SNAPSHOT_TABLES.length}, got ${results.length}`,
    )
  }
  const protocol = {} as ProtocolSnapshot
  for (const [index, [table, , requiredColumns]] of SNAPSHOT_TABLES.entries()) {
    const rows = results[index]?.rows
    if (!Array.isArray(rows)) {
      throw new Error(`poison snapshot result ${index} has no rows array`)
    }
    for (const [rowIndex, row] of rows.entries()) {
      const missing = requiredColumns.filter(
        (column) => !Object.prototype.hasOwnProperty.call(row, column),
      )
      if (missing.length > 0) {
        throw new Error(
          `poison snapshot ${table} row ${rowIndex} is missing required column ${missing.join(',')}`,
        )
      }
    }
    protocol[table] = rows
  }
  return protocol
}

async function seedBase(f: StoreFixture): Promise<void> {
  await f.admin.setFakeNowEpochMs(NOW)
  await f.raw.batch(
    'poison:setup',
    [
      sql(
        `INSERT INTO tasks
           (task_id, queue, task_name, params, retry_strategy, max_attempts,
            idempotency_key, state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
         VALUES (?, ?, 'poison', '{}', '{"kind":"none"}', 5, ?, 'running', 0, 0, ?, ?)`,
        [TASK, Q, IDEMPOTENCY_KEY, NOW, NOW],
      ),
      sql(
        `INSERT INTO runs
           (run_id, queue, task_id, attempt, state, claimed_by, claim_gen, activated_gen,
            relaunch_count, lease_ms, claim_expires_at_ms, heartbeat_at_ms, created_at_ms)
         VALUES (?, ?, ?, 1, 'running', ?, 1, 1, 0, 60000, ?, ?, ?)`,
        [RUN, Q, TASK, TOKEN, NOW + 60_000, NOW, NOW],
      ),
      sql(
        `INSERT INTO tasks
           (task_id, queue, task_name, params, retry_strategy, max_attempts,
            state, attempts, infra_retries, completed_payload, enqueue_at_ms, created_at_ms)
         VALUES (?, ?, 'canary', '{}', '{"kind":"none"}', 1,
                 'completed', 0, 0, '{"canary":true}', ?, ?)`,
        [CANARY_TASK, Q, NOW, NOW],
      ),
      sql(
        `INSERT INTO tasks
           (task_id, queue, task_name, params, retry_strategy, max_attempts,
            state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
         VALUES (?, ?, 'protected', '{}', '{"kind":"none"}', 5,
                 'sleeping', 0, 0, ?, ?)`,
        [PROTECTED_TASK, Q, NOW, NOW],
      ),
      sql(
        `INSERT INTO runs
           (run_id, queue, task_id, attempt, state, available_at_ms,
            wake_event, wake_step, created_at_ms)
         VALUES (?, ?, ?, 1, 'sleeping', NULL, ?, ?, ?)`,
        [PROTECTED_RUN, Q, PROTECTED_TASK, PROTECTED_WAIT_EVENT, PROTECTED_STEP, NOW],
      ),
      sql(
        `INSERT INTO waits
           (run_id, step_name, queue, task_id, event_name, status,
            timeout_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 'waiting', NULL, ?)`,
        [PROTECTED_RUN, PROTECTED_STEP, Q, PROTECTED_TASK, PROTECTED_WAIT_EVENT, NOW],
      ),
      sql(
        `INSERT INTO checkpoints
           (task_id, checkpoint_name, queue, state, status,
            owner_run_id, owner_attempt, updated_at_ms)
         VALUES (?, 'protected-checkpoint', ?, '{}', 'committed', ?, 1, ?)`,
        [PROTECTED_TASK, Q, PROTECTED_RUN, NOW],
      ),
      sql(
        `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
         VALUES (?, ?, '{"protected":true}', ?)`,
        [Q, PROTECTED_EVENT, NOW],
      ),
      sql(
        `INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)`,
        [Q, PROTECTED_DRIVER, NOW, NOW + 3_600_000],
      ),
    ],
    'write',
  )
}

async function preparePoisonTarget(
  raw: SqlExecutor,
  profile: PoisonTargetProfile,
  companions: CounterSeedOverrides,
): Promise<void> {
  const seed = POISON_TARGET_PROFILE_SEEDS[profile]

  await raw.batch(
    'poison:target-profile',
    [
      sql(
        `UPDATE tasks
         SET state = ?, attempts = ?, max_attempts = ?, infra_retries = ?
         WHERE task_id = ?`,
        [seed.state, seed.taskAttempts, seed.taskMaxAttempts, seed.taskInfraRetries, TASK],
      ),
      sql(
        `UPDATE runs
         SET state = ?, attempt = ?, claimed_by = ?, claim_gen = ?, activated_gen = ?,
             relaunch_count = ?, lease_ms = ?, claim_expires_at_ms = ?,
             heartbeat_at_ms = ?, available_at_ms = ?
         WHERE run_id = ?`,
        [
          seed.state,
          seed.runAttempt,
          seed.claimedBy,
          seed.claimGen,
          seed.activatedGen,
          seed.runRelaunchCount,
          seed.leaseMs,
          seed.claimExpiresAtMs,
          seed.heartbeatAtMs,
          seed.availableAtMs,
          RUN,
        ],
      ),
    ],
    'write',
  )

  const findings = await engineInvariantFindings(raw)
  if (findings.length > 0) {
    throw new Error(
      `${profile}: target profile is not a clean pre-corruption world: ${findings
        .map((finding) => finding.message)
        .join('; ')}`,
    )
  }

  if (Object.keys(companions).length === 0) return

  // Some boundary witnesses need a coordinated second value to isolate the
  // target field. Apply it only after proving the lifecycle profile itself is
  // a clean world; the witness immediately completes the coordinated state.
  await raw.batch(
    'poison:target-companions',
    [
      sql(
        `UPDATE tasks
         SET attempts = ?, max_attempts = ?, infra_retries = ?
         WHERE task_id = ?`,
        [
          companions.attempts ?? seed.taskAttempts,
          companions.maxAttempts ?? seed.taskMaxAttempts,
          companions.infraRetries ?? seed.taskInfraRetries,
          TASK,
        ],
      ),
      sql(
        `UPDATE runs
         SET attempt = ?, claim_gen = ?, activated_gen = ?, relaunch_count = ?
         WHERE run_id = ?`,
        [
          companions.attempt ?? seed.runAttempt,
          companions.claimGen ?? seed.claimGen,
          companions.activatedGen ?? seed.activatedGen,
          companions.relaunchCount ?? seed.runRelaunchCount,
          RUN,
        ],
      ),
    ],
    'write',
  )
}

function triggerTask(
  state: 'pending' | 'running' | 'sleeping',
  cancelAt: number | null = null,
): SqlStatement {
  return sql(
    `INSERT INTO tasks
       (task_id, queue, task_name, params, retry_strategy, max_attempts,
        cancellation, state, attempts, infra_retries, enqueue_at_ms, cancel_at_ms, created_at_ms)
     VALUES (?, ?, 'trigger', '{}', '{"kind":"none"}', 5, ?, ?, 0, 0, ?, ?, ?)`,
    [
      TRIGGER_TASK,
      Q,
      cancelAt === null ? null : '{"maxDelaySeconds":1}',
      state,
      NOW,
      cancelAt,
      NOW,
    ],
  )
}

function triggerRun(options: {
  state: 'pending' | 'running' | 'sleeping'
  activatedGen?: number
  expiresAt?: number | null
  availableAt?: number | null
  wakeEvent?: string | null
  wakeStep?: string | null
}): SqlStatement {
  const running = options.state === 'running'
  return sql(
    `INSERT INTO runs
       (run_id, queue, task_id, attempt, state, claimed_by, claim_gen, activated_gen,
        relaunch_count, lease_ms, claim_expires_at_ms, heartbeat_at_ms,
        available_at_ms, wake_event, wake_step, created_at_ms)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TRIGGER_RUN,
      Q,
      TRIGGER_TASK,
      options.state,
      running ? TRIGGER_TOKEN : null,
      running ? 1 : 0,
      running ? (options.activatedGen ?? 1) : 0,
      running ? 60_000 : null,
      running ? (options.expiresAt ?? NOW + 60_000) : null,
      running ? NOW - 1 : null,
      options.availableAt ?? null,
      options.wakeEvent ?? null,
      options.wakeStep ?? null,
      NOW,
    ],
  )
}

/** A task that ended with no completion event, as a build older than the event leaves it. */
function endedChild(taskId: string): SqlStatement {
  return sql(
    `INSERT INTO tasks
       (task_id, queue, task_name, params, retry_strategy, max_attempts,
        state, attempts, infra_retries, completed_payload, enqueue_at_ms, created_at_ms)
     VALUES (?, ?, 'ended-child', '{}', '{"kind":"none"}', 1,
             'completed', 0, 0, '{"ended":true}', ?, ?)`,
    [taskId, Q, NOW, NOW],
  )
}

/** The attempt record a `fail-rollback` invocation writes. */
const ROLLBACK_STEP = 'probe'
const ROLLBACK_TRIED = `${SAGA_TRIES_PREFIX}${ROLLBACK_STEP}`

/** The saga checkpoints of a task that is rolling back with one rollback owed. */
const rollingBack = (taskId: string, runId: string): SqlStatement[] =>
  [
    [`${SAGA_STARTED_PREFIX}probe`, '1'],
    [SAGA_PHASE_CHECKPOINT, '{"name":"ProbeCause"}'],
  ].map(([name, state]) =>
    sql(
      `INSERT INTO checkpoints
         (task_id, checkpoint_name, queue, state, status, owner_run_id, owner_attempt, updated_at_ms)
       VALUES (?, ?, ?, ?, 'committed', ?, 1, ?)`,
      [taskId, name as string, Q, state as string, runId, NOW],
    ),
  )

async function seedHealthyTrigger(raw: SqlExecutor, label: string): Promise<void> {
  if (label === 'driver-heartbeat' || label === 'spawn') return
  let statements: readonly SqlStatement[]
  switch (label) {
    case 'claim':
      statements = [triggerTask('pending'), triggerRun({ state: 'pending', availableAt: NOW })]
      break
    case 'activate':
    case 'defer-launch':
      statements = [triggerTask('running'), triggerRun({ state: 'running', activatedGen: 0 })]
      break
    case 'record-task-done':
      // The awaiting run is running, and each invocation's child ended with nothing recorded.
      statements = [
        triggerTask('running'),
        triggerRun({ state: 'running' }),
        endedChild(ENDED_CHILD),
        endedChild(TRIGGER_ENDED_CHILD),
      ]
      break
    case 'emit-event':
      statements = [
        triggerTask('sleeping'),
        triggerRun({
          state: 'sleeping',
          wakeEvent: TRIGGER_EVENT,
          wakeStep: TRIGGER_STEP,
        }),
        sql(
          `INSERT INTO waits
             (run_id, step_name, queue, task_id, event_name, status,
              timeout_at_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, 'waiting', NULL, ?)`,
          [TRIGGER_RUN, TRIGGER_STEP, Q, TRIGGER_TASK, TRIGGER_EVENT, NOW],
        ),
      ]
      break
    case 'retry-task':
      statements = [
        sql(
          `INSERT INTO tasks
             (task_id, queue, task_name, params, retry_strategy, max_attempts, state,
              attempts, infra_retries, failure_reason, enqueue_at_ms, created_at_ms)
           VALUES (?, ?, 'trigger', '{}', '{"kind":"none"}', 1, 'failed', 1, 0,
                   '{"name":"TriggerFailed"}', ?, ?)`,
          [TRIGGER_TASK, Q, NOW, NOW],
        ),
        sql(
          `INSERT INTO runs
             (run_id, queue, task_id, attempt, state, failure_reason, created_at_ms)
           VALUES (?, ?, ?, 1, 'failed', '{"name":"TriggerFailed"}', ?)`,
          [TRIGGER_RUN, Q, TRIGGER_TASK, NOW],
        ),
      ]
      break
    case 'cancel-task':
      statements = [
        triggerTask('pending'),
        triggerRun({ state: 'pending', availableAt: NOW + 60_000 }),
      ]
      break
    case 'sweep:cancel':
      statements = [
        triggerTask('pending', NOW - 1),
        triggerRun({ state: 'pending', availableAt: NOW }),
      ]
      break
    case 'sweep:lost-launch':
      statements = [
        triggerTask('running'),
        triggerRun({ state: 'running', activatedGen: 0, expiresAt: NOW - 1 }),
      ]
      break
    case 'sweep:claim-timeout':
      statements = [
        triggerTask('running'),
        triggerRun({ state: 'running', activatedGen: 1, expiresAt: NOW - 1 }),
      ]
      break
    case 'fail-rollback':
      // A failed rollback is one only while its task is rolling back, so both the
      // trigger and the poisoned task stand in the phase, with one rollback owed.
      statements = [
        triggerTask('running'),
        triggerRun({ state: 'running' }),
        ...rollingBack(TRIGGER_TASK, TRIGGER_RUN),
        ...rollingBack(TASK, RUN),
      ]
      break
    default:
      statements = [triggerTask('running'), triggerRun({ state: 'running' })]
  }
  await raw.batch('poison:trigger', statements, 'write')
}

interface InvocationTarget {
  driverId: string
  taskName: string
  taskId: string
  runId: string
  token: string
  claimWorker: string
  eventName: string
  stepName: string
  idempotencyKey: string
  suspensionKey: string
  checkpointName: string
  eventPayload: string
  completionPayload: string
  failure: string
  endedChildId: string
}

const POISON_INVOCATION: InvocationTarget = {
  driverId: POISON_DRIVER,
  taskName: 'poison',
  taskId: TASK,
  runId: RUN,
  token: TOKEN,
  claimWorker: 'poison-claim',
  eventName: EVENT,
  stepName: STEP,
  idempotencyKey: IDEMPOTENCY_KEY,
  suspensionKey: 'poison-sleep',
  checkpointName: 'poison-probe',
  eventPayload: '{"delivered":true}',
  completionPayload: '{"ok":true}',
  failure: '{"name":"PoisonProbe"}',
  endedChildId: ENDED_CHILD,
}

const HEALTHY_INVOCATION: InvocationTarget = {
  driverId: TRIGGER_DRIVER,
  taskName: 'trigger',
  taskId: TRIGGER_TASK,
  runId: TRIGGER_RUN,
  token: TRIGGER_TOKEN,
  claimWorker: 'healthy-claim',
  eventName: TRIGGER_EVENT,
  stepName: TRIGGER_STEP,
  idempotencyKey: TRIGGER_IDEMPOTENCY_KEY,
  suspensionKey: 'trigger-sleep',
  checkpointName: 'trigger-checkpoint',
  eventPayload: '{"healthy":true}',
  completionPayload: '{"healthy":true}',
  failure: '{"name":"HealthyProbe"}',
  endedChildId: TRIGGER_ENDED_CHILD,
}

async function invoke(
  label: (typeof MATRIX_WRITE_LABELS)[number],
  store: SchedulerStore,
  target: InvocationTarget,
  selectionLimit = 100,
): Promise<unknown> {
  switch (label) {
    case 'driver-heartbeat':
      return store.driverHeartbeat(Q, target.driverId, 30)
    case 'spawn':
      return store.spawn(Q, target.taskName, '{}', { idempotencyKey: target.idempotencyKey })
    case 'claim':
      return store.claim(Q, target.claimWorker, { leaseSeconds: 60, limit: selectionLimit })
    case 'activate':
      return store.activate(Q, target.runId, target.token, 1)
    case 'defer-launch':
      return store.deferLaunch(Q, target.runId, target.token, 1, 1)
    case 'heartbeat':
      return store.heartbeat(Q, target.runId, target.token, 60)
    case 'reschedule':
      return store.reschedule(Q, target.runId, target.token, { inSeconds: 1 })
    case 'suspend':
      return store.suspendRun(
        Q,
        target.runId,
        target.token,
        { inSeconds: 1 },
        { key: target.suspensionKey, stateJson: '{}' },
      )
    case 'emit-event':
      return store.emitEvent(Q, target.eventName, target.eventPayload)
    case 'await-event':
      return store.awaitEvent(
        Q,
        target.taskId,
        target.runId,
        target.token,
        target.stepName,
        target.eventName,
        30,
      )
    case 'record-task-done':
      return store.awaitTaskDone(
        Q,
        target.taskId,
        target.runId,
        target.token,
        target.stepName,
        target.endedChildId,
        null,
      )
    case 'complete':
      return store.complete(Q, target.runId, target.token, target.completionPayload)
    case 'fail':
      return store.fail(Q, target.runId, target.token, target.failure, null)
    case 'fail-rollback':
      return store.failRollback(Q, target.runId, target.token, target.failure, null, {
        stepKey: ROLLBACK_STEP,
        errorJson: target.failure,
      })
    case 'cancel-task':
      return store.cancelTask(Q, target.taskId)
    case 'expire-lease-now':
      return store.expireLeaseNow(Q, target.runId, target.token)
    case 'set-checkpoint':
      return store.setCheckpoint(
        Q,
        target.taskId,
        target.runId,
        target.token,
        target.checkpointName,
        '{}',
        60,
      )
    case 'retry-task':
      return store.retryTask(Q, target.taskId)
    case 'sweep:cancel':
    case 'sweep:lost-launch':
    case 'sweep:claim-timeout':
      return store.sweep(Q, selectionLimit)
    default:
      throw new Error(`poison matrix has no driver for write label '${label}'`)
  }
}

function key(table: SnapshotTable, row: SqlRow): string {
  switch (table) {
    case 'tasks':
      return String(row.task_id)
    case 'runs':
      return String(row.run_id)
    case 'checkpoints':
      return JSON.stringify([String(row.task_id), String(row.checkpoint_name)])
    case 'events':
      return JSON.stringify([String(row.queue), String(row.event_name)])
    case 'waits':
      return JSON.stringify([String(row.run_id), String(row.step_name)])
    case 'drivers':
      return JSON.stringify([String(row.queue), String(row.driver_id)])
  }
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  const leftInteger = exactInteger(left)
  const rightInteger = exactInteger(right)
  if (leftInteger !== undefined && rightInteger !== undefined) {
    return leftInteger === rightInteger
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((name, index) => name === rightKeys[index]) &&
    leftKeys.every((name) => same(leftRecord[name], rightRecord[name]))
  )
}

function rowsByKey(table: SnapshotTable, rows: readonly SqlRow[]): Map<string, SqlRow> {
  return new Map(rows.map((row) => [key(table, row), row]))
}

type FrozenAuthority = Record<SnapshotTable, ReadonlySet<string>>
type ExpectedInsertion = Readonly<Record<string, string | number | bigint | null>>
type InsertAuthority = Record<SnapshotTable, Map<string, ExpectedInsertion>>

type PoisonInvocationTarget = 'poison' | 'healthy'

export type PoisonInvocationOutcome<
  Target extends PoisonInvocationTarget = PoisonInvocationTarget,
> =
  | Readonly<{
      target: Target
      status: 'fulfilled'
      result: unknown
    }>
  | Readonly<{
      target: Target
      status: 'rejected'
      reason: unknown
    }>

function freezeAuthority(before: ProtocolSnapshot): FrozenAuthority {
  const taskIds = new Set([TASK, TRIGGER_TASK])
  const runIds = new Set([RUN, RUN_2, GHOST_RUN, TRIGGER_RUN])
  for (const run of before.runs) {
    if (taskIds.has(String(run.task_id))) runIds.add(String(run.run_id))
  }
  return {
    tasks: new Set(
      before.tasks
        .filter((row) => taskIds.has(String(row.task_id)))
        .map((row) => key('tasks', row)),
    ),
    runs: new Set(
      before.runs.filter((row) => runIds.has(String(row.run_id))).map((row) => key('runs', row)),
    ),
    waits: new Set(
      before.waits.filter((row) => runIds.has(String(row.run_id))).map((row) => key('waits', row)),
    ),
    checkpoints: new Set(
      before.checkpoints
        .filter((row) => runIds.has(String(row.owner_run_id)))
        .map((row) => key('checkpoints', row)),
    ),
    events: new Set(
      before.events
        .filter((row) => row.queue === Q && [EVENT, TRIGGER_EVENT].includes(String(row.event_name)))
        .map((row) => key('events', row)),
    ),
    drivers: new Set(
      before.drivers
        .filter(
          (row) =>
            row.queue === Q && [POISON_DRIVER, TRIGGER_DRIVER].includes(String(row.driver_id)),
        )
        .map((row) => key('drivers', row)),
    ),
  }
}

function emptyInsertAuthority(): InsertAuthority {
  return {
    tasks: new Map(),
    runs: new Map(),
    checkpoints: new Map(),
    events: new Map(),
    waits: new Map(),
    drivers: new Map(),
  }
}

function allowInsert(
  authority: InsertAuthority,
  table: SnapshotTable,
  expected: ExpectedInsertion,
): void {
  authority[table].set(key(table, expected), expected)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function explicitInsertAuthority(
  label: string,
  before: ProtocolSnapshot,
  outcomes: readonly PoisonInvocationOutcome[],
): InsertAuthority {
  const authority = emptyInsertAuthority()
  const poisonAttempt = exactInteger(before.runs.find((run) => run.run_id === RUN)?.attempt) ?? 1n
  if (label === 'driver-heartbeat') {
    for (const driverId of [POISON_DRIVER, TRIGGER_DRIVER]) {
      allowInsert(authority, 'drivers', { queue: Q, driver_id: driverId })
    }
  }
  if ((TERMINAL_BATCH_LABELS as readonly string[]).includes(label)) {
    // A terminal batch writes the completion event of the task it ends
    // (specs/ChildTasks.tla). `completionEventBarrier` holds each one to a task this
    // call took from live to terminal.
    allowInsert(authority, 'events', { queue: Q, event_name: taskDoneEventName(TASK) })
    allowInsert(authority, 'events', { queue: Q, event_name: taskDoneEventName(TRIGGER_TASK) })
  }
  if (label === 'emit-event') {
    allowInsert(authority, 'events', { queue: Q, event_name: EVENT })
    allowInsert(authority, 'events', { queue: Q, event_name: TRIGGER_EVENT })
  }
  if (label === 'await-event') {
    allowInsert(authority, 'waits', {
      run_id: RUN,
      step_name: STEP,
      queue: Q,
      task_id: TASK,
      event_name: EVENT,
    })
    allowInsert(authority, 'waits', {
      run_id: TRIGGER_RUN,
      step_name: TRIGGER_STEP,
      queue: Q,
      task_id: TRIGGER_TASK,
      event_name: TRIGGER_EVENT,
    })
  }
  if (label === 'record-task-done') {
    // The await of a child that ended with nothing recorded writes that child's event.
    // `completionEventBarrier` holds it to a terminal task the call left as it was.
    allowInsert(authority, 'events', { queue: Q, event_name: taskDoneEventName(ENDED_CHILD) })
    allowInsert(authority, 'events', {
      queue: Q,
      event_name: taskDoneEventName(TRIGGER_ENDED_CHILD),
    })
  }
  if (label === 'suspend') {
    allowInsert(authority, 'checkpoints', {
      task_id: TASK,
      checkpoint_name: 'poison-sleep',
      queue: Q,
      owner_run_id: RUN,
      owner_attempt: poisonAttempt,
    })
    allowInsert(authority, 'checkpoints', {
      task_id: TRIGGER_TASK,
      checkpoint_name: 'trigger-sleep',
      queue: Q,
      owner_run_id: TRIGGER_RUN,
      owner_attempt: 1,
    })
  }
  if (label === 'fail-rollback') {
    // A failed rollback writes its attempt record, under the run that failed.
    allowInsert(authority, 'checkpoints', {
      task_id: TASK,
      checkpoint_name: ROLLBACK_TRIED,
      queue: Q,
      owner_run_id: RUN,
      owner_attempt: poisonAttempt,
    })
    allowInsert(authority, 'checkpoints', {
      task_id: TRIGGER_TASK,
      checkpoint_name: ROLLBACK_TRIED,
      queue: Q,
      owner_run_id: TRIGGER_RUN,
      owner_attempt: 1,
    })
  }
  if (label === 'set-checkpoint') {
    allowInsert(authority, 'checkpoints', {
      task_id: TASK,
      checkpoint_name: 'poison-probe',
      queue: Q,
      owner_run_id: RUN,
      owner_attempt: poisonAttempt,
    })
    allowInsert(authority, 'checkpoints', {
      task_id: TRIGGER_TASK,
      checkpoint_name: 'trigger-checkpoint',
      queue: Q,
      owner_run_id: TRIGGER_RUN,
      owner_attempt: 1,
    })
  }

  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') continue
    if (label === 'spawn') {
      const result = object(outcome.result)
      if (
        result?.created === true &&
        typeof result.taskId === 'string' &&
        typeof result.runId === 'string'
      ) {
        allowInsert(authority, 'tasks', { task_id: result.taskId, queue: Q })
        allowInsert(authority, 'runs', {
          run_id: result.runId,
          queue: Q,
          task_id: result.taskId,
          attempt: 1,
        })
      }
    }
    if (label === 'retry-task') {
      // A revival inserts exactly one run: the id and ordinal it returned, under
      // the task the invocation named.
      const result = object(outcome.result)
      const taskId =
        outcome.target === 'poison' ? POISON_INVOCATION.taskId : HEALTHY_INVOCATION.taskId
      const attempt = exactInteger(result?.attempt)
      if (typeof result?.runId === 'string' && attempt !== undefined) {
        allowInsert(authority, 'runs', { run_id: result.runId, queue: Q, task_id: taskId, attempt })
      }
    }
    if (label === 'sweep:claim-timeout' && Array.isArray(outcome.result)) {
      for (const itemValue of outcome.result) {
        const item = object(itemValue)
        if (
          item?.kind !== 'claim-timeout' ||
          typeof item.successorRunId !== 'string' ||
          typeof item.taskId !== 'string' ||
          typeof item.runId !== 'string'
        ) {
          continue
        }
        const predecessor = before.runs.find((run) => run.run_id === item.runId)
        const predecessorAttempt = exactInteger(predecessor?.attempt)
        if (
          !predecessor ||
          predecessor.task_id !== item.taskId ||
          predecessorAttempt === undefined
        ) {
          continue
        }
        allowInsert(authority, 'runs', {
          run_id: item.successorRunId,
          queue: String(predecessor.queue),
          task_id: String(predecessor.task_id),
          attempt: predecessorAttempt + 1n,
        })
      }
    }
  }
  return authority
}

function changedOutsideAuthority(
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
  frozen: FrozenAuthority,
  inserts: InsertAuthority,
): string[] {
  const changed: string[] = []
  for (const [table] of SNAPSHOT_TABLES) {
    const left = rowsByKey(table, before[table])
    const right = rowsByKey(table, after[table])
    for (const rowKey of new Set([...left.keys(), ...right.keys()])) {
      const beforeRow = left.get(rowKey)
      const afterRow = right.get(rowKey)
      if (same(beforeRow, afterRow)) continue
      if (beforeRow) {
        if (!frozen[table].has(rowKey)) {
          changed.push(`${table}/${rowKey} was outside frozen pre-state authority`)
          continue
        }
        if (afterRow) {
          const changedRelationships = RELATIONSHIP_COLUMNS[table].filter(
            (column) => !same(beforeRow[column], afterRow[column]),
          )
          if (changedRelationships.length > 0) {
            changed.push(
              `${table}/${rowKey} changed relationship ${changedRelationships.join(',')}`,
            )
          }
        }
        continue
      }
      const expected = inserts[table].get(rowKey)
      if (!expected || !afterRow) {
        changed.push(`${table}/${rowKey} was not an explicitly allowed insertion`)
        continue
      }
      const wrong = Object.entries(expected)
        .filter(([column, value]) => !same(afterRow[column], value))
        .map(([column]) => column)
      if (wrong.length > 0) {
        changed.push(`${table}/${rowKey} inserted with wrong ownership ${wrong.join(',')}`)
      }
    }
  }
  return changed
}

/** `row` without the named columns, for a barrier that lets exactly those change. */
function withoutColumns(row: SqlRow, columns: ReadonlySet<string>): SqlRow {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !columns.has(name))) as SqlRow
}

const LEASE_DEADLINE_COLUMNS: ReadonlySet<string> = new Set(['claim_expires_at_ms'])

/** The task columns a revival writes; every other column of a revived task stays put. */
const REVIVAL_TASK_COLUMNS: ReadonlySet<string> = new Set([
  'state',
  'attempts',
  'max_attempts',
  'failure_reason',
  'last_attempt_run',
  'fence_stamp',
  'fence_at_ms',
])

function liveRuns(snapshot: ProtocolSnapshot, taskId: string): SqlRow[] {
  return snapshot.runs.filter((row) => row.task_id === taskId && isLiveState(row.state)) as SqlRow[]
}

function leaseOnlyShortened(before: SqlRow, after: SqlRow): boolean {
  const beforeDeadline = exactInteger(before.claim_expires_at_ms)
  const afterDeadline = exactInteger(after.claim_expires_at_ms)
  if (
    beforeDeadline === undefined ||
    afterDeadline === undefined ||
    afterDeadline > beforeDeadline
  ) {
    return false
  }
  return same(
    withoutColumns(before, LEASE_DEADLINE_COLUMNS),
    withoutColumns(after, LEASE_DEADLINE_COLUMNS),
  )
}

/**
 * A completion event may appear only for a task this call took from live to terminal,
 * and only in that task's queue. The one other writer is `record-task-done`, the await
 * of a child that ended with nothing recorded: its task was terminal before the call,
 * and the call left that row exactly as it was. The insert authority allows the event by
 * name. This barrier is what stops a refused or laundering transition from writing one
 * anyway.
 */
function completionEventBarrier(
  label: string,
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
): string[] {
  const existed = rowsByKey('events', before.events)
  const beforeTasks = rowsByKey('tasks', before.tasks)
  const afterTasks = rowsByKey('tasks', after.tasks)
  const errors: string[] = []
  for (const event of after.events) {
    const eventName = String(event.event_name)
    const taskId = taskIdOfDoneEvent(eventName)
    if (taskId === null || existed.has(key('events', event))) continue
    const was = beforeTasks.get(taskId)
    const is = afterTasks.get(taskId)
    const ended =
      was !== undefined &&
      is !== undefined &&
      isLiveState(was.state) &&
      isTerminalState(is.state) &&
      String(is.queue) === String(event.queue)
    const recorded =
      label === 'record-task-done' &&
      was !== undefined &&
      is !== undefined &&
      isTerminalState(was.state) &&
      same(was, is) &&
      String(is.queue) === String(event.queue)
    if (!ended && !recorded) {
      errors.push(`completion event ${eventName} was written for a task this call did not end`)
    }
  }
  return errors
}

function terminalBarrier(
  label: string,
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
): string[] {
  const errors: string[] = []
  const afterTasks = rowsByKey('tasks', after.tasks)
  const afterRuns = rowsByKey('runs', after.runs)
  for (const task of before.tasks) {
    if (!isTerminalState(task.state)) continue
    const taskId = String(task.task_id)
    const afterTask = afterTasks.get(taskId)
    // retryTask is the one sanctioned exit from a terminal state: a FAILED task
    // may return to pending, change only the columns a revival writes, and acquire
    // the single revival run the insert authority allowed. Completed and cancelled
    // tasks stay barred.
    const revived =
      label === 'retry-task' &&
      task.state === 'failed' &&
      afterTask?.state === 'pending' &&
      liveRuns(after, taskId).length === 1 &&
      liveRuns(before, taskId).length === 0
    if (revived) {
      if (
        !same(
          withoutColumns(task, REVIVAL_TASK_COLUMNS),
          withoutColumns(afterTask, REVIVAL_TASK_COLUMNS),
        )
      ) {
        errors.push(`revived task ${taskId} changed a column a revival does not write`)
      }
      continue
    }
    if (!same(task, afterTask)) errors.push(`terminal task ${taskId} changed`)
    const oldLiveRuns = liveRuns(before, taskId)
    const oldLiveIds = new Set(oldLiveRuns.map((run) => String(run.run_id)))
    for (const run of oldLiveRuns) {
      const afterRun = afterRuns.get(String(run.run_id))
      const advisoryShortening =
        label === 'expire-lease-now' && afterRun && leaseOnlyShortened(run, afterRun)
      if (afterRun && isLiveState(afterRun.state) && !same(run, afterRun) && !advisoryShortening) {
        errors.push(`live run ${String(run.run_id)} under terminal task ${taskId} was revived`)
      }
    }
    for (const run of liveRuns(after, taskId)) {
      if (!oldLiveIds.has(String(run.run_id))) {
        errors.push(`terminal task ${taskId} acquired live run ${String(run.run_id)}`)
      }
    }
  }
  return errors
}

function inertLiveBarrier(
  label: string,
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
): string[] {
  const errors: string[] = []
  const beforeRuns = liveRuns(before, TASK)
  const afterRuns = rowsByKey('runs', after.runs)
  const oldIds = new Set(beforeRuns.map((run) => String(run.run_id)))
  for (const run of beforeRuns) {
    const current = afterRuns.get(String(run.run_id))
    const advisoryShortening =
      label === 'expire-lease-now' && current && leaseOnlyShortened(run, current)
    if (current && isLiveState(current.state) && !same(run, current) && !advisoryShortening) {
      errors.push(`poisoned live run ${String(run.run_id)} changed without quiescing`)
    }
  }
  for (const run of liveRuns(after, TASK)) {
    if (!oldIds.has(String(run.run_id))) {
      errors.push(`poisoned task acquired new live run ${String(run.run_id)}`)
    }
  }
  return errors
}

function exactInteger(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  return undefined
}

function rowById(
  snapshot: ProtocolSnapshot,
  table: 'tasks' | 'runs',
  id: string,
): SqlRow | undefined {
  const column = table === 'tasks' ? 'task_id' : 'run_id'
  return snapshot[table].find((row) => row[column] === id)
}

function integerBoundSeverity(value: unknown, bounds: IntegerBounds): bigint {
  const exact = exactInteger(value)
  if (exact === undefined) return 0n
  const minimum = BigInt(bounds.min)
  const maximum = BigInt(bounds.max)
  if (exact < minimum) return minimum - exact
  if (exact > maximum) return exact - maximum
  return 0n
}

function counterBoundSeverity(
  finding: EngineInvariantFinding,
  snapshot: ProtocolSnapshot,
): bigint | undefined {
  if (!finding.conditionId.startsWith('counter-bound/')) return undefined
  const fieldId = finding.conditionId.slice('counter-bound/'.length)
  const field = PERSISTED_COUNTER_FIELDS.find((candidate) => candidate.id === fieldId)
  if (!field) return undefined
  if (field.table === 'checkpoints') {
    const taskId = finding.subjectIdentity[1]
    const checkpointName = finding.subjectIdentity[2]
    const row =
      taskId === undefined || checkpointName === undefined
        ? undefined
        : checkpointByName(snapshot, taskId, checkpointName)
    return integerBoundSeverity(row?.[field.column], field.bounds)
  }
  const rowId = finding.subjectIdentity[1]
  const row = rowId === undefined ? undefined : rowById(snapshot, field.table, rowId)
  return integerBoundSeverity(row?.[field.column], field.bounds)
}

function temporalRow(
  snapshot: ProtocolSnapshot,
  finding: EngineInvariantFinding,
  field: PersistedTemporalFieldDescriptor,
): SqlRow | undefined {
  const [table, first, second] = finding.subjectIdentity
  if (table !== field.table || first === undefined) return undefined
  switch (field.table) {
    case 'tasks':
    case 'runs':
      return rowById(snapshot, field.table, first)
    case 'checkpoints':
      return second === undefined ? undefined : checkpointByName(snapshot, first, second)
    case 'events':
      return second === undefined
        ? undefined
        : snapshot.events.find((row) => row.queue === first && row.event_name === second)
    case 'waits':
      return second === undefined
        ? undefined
        : snapshot.waits.find((row) => row.run_id === first && row.step_name === second)
    case 'drivers':
      return second === undefined
        ? undefined
        : snapshot.drivers.find((row) => row.queue === first && row.driver_id === second)
  }
}

function temporalBoundSeverity(
  finding: EngineInvariantFinding,
  snapshot: ProtocolSnapshot,
): bigint | undefined {
  if (!finding.conditionId.startsWith('temporal-bound/')) return undefined
  const fieldId = finding.conditionId.slice('temporal-bound/'.length)
  const field = PERSISTED_TEMPORAL_FIELDS.find((candidate) => candidate.id === fieldId)
  if (!field) return undefined
  const row = temporalRow(snapshot, finding, field)
  return integerBoundSeverity(row?.[field.column], field.bounds)
}

/**
 * Pure severity oracle. Its direct witnesses keep failures in this mechanism
 * attributable instead of routing them through transition and closure checks.
 */
export function findingSeverity(
  finding: EngineInvariantFinding,
  snapshot: ProtocolSnapshot,
): bigint {
  const temporalSeverity = temporalBoundSeverity(finding, snapshot)
  if (temporalSeverity !== undefined) return temporalSeverity
  const counterSeverity = counterBoundSeverity(finding, snapshot)
  if (counterSeverity !== undefined) return counterSeverity
  const primarySubject = finding.subjectIdentity[0] ?? finding.subject
  const task = rowById(snapshot, 'tasks', primarySubject)
  const run = rowById(snapshot, 'runs', primarySubject)
  switch (finding.conditionId) {
    case 'attempts/over-max': {
      const attempts = exactInteger(task?.attempts)
      const maximum = exactInteger(task?.max_attempts)
      return attempts !== undefined && maximum !== undefined && attempts > maximum
        ? attempts - maximum
        : 0n
    }
    case 'attempts/at-max-with-live-run': {
      const attempts = exactInteger(task?.attempts)
      const maximum = exactInteger(task?.max_attempts)
      return attempts !== undefined && maximum !== undefined && attempts >= maximum
        ? attempts - maximum + 1n
        : 0n
    }
    case 'accounting/above-top':
    case 'accounting/below-top-minus-one': {
      const attempts = exactInteger(task?.attempts)
      const infra = exactInteger(task?.infra_retries)
      const owned = snapshot.runs.filter((candidate) => candidate.task_id === primarySubject)
      const ordinals = owned
        .map((candidate) => exactInteger(candidate.attempt))
        .filter((value): value is bigint => value !== undefined)
      if (attempts === undefined || infra === undefined || ordinals.length === 0) return 0n
      const top = ordinals.reduce((highest, value) => (value > highest ? value : highest))
      const accounted = attempts + infra
      return finding.conditionId === 'accounting/above-top'
        ? accounted > top
          ? accounted - top
          : 0n
        : accounted < top - 1n
          ? top - 1n - accounted
          : 0n
    }
    case 'accounting/failed-charge-past-budget': {
      const maximum = exactInteger(task?.max_attempts)
      const infra = exactInteger(task?.infra_retries)
      const ordinals = snapshot.runs
        .filter((candidate) => candidate.task_id === primarySubject)
        .map((candidate) => exactInteger(candidate.attempt))
        .filter((value): value is bigint => value !== undefined)
      if (maximum === undefined || infra === undefined || ordinals.length === 0) return 0n
      const top = ordinals.reduce((highest, value) => (value > highest ? value : highest))
      return top - infra > maximum ? top - infra - maximum : 0n
    }
    case 'accounting/live-run-not-next': {
      const attempts = exactInteger(task?.attempts)
      const infra = exactInteger(task?.infra_retries)
      const current = liveRuns(snapshot, primarySubject)
      const attempt = current.length === 1 ? exactInteger(current[0]?.attempt) : undefined
      if (attempts === undefined || infra === undefined || attempt === undefined) return 0n
      const expected = attempts + infra + 1n
      return attempt > expected ? attempt - expected : expected - attempt
    }
    case 'generation/activated-after-claim': {
      const activated = exactInteger(run?.activated_gen)
      const claimed = exactInteger(run?.claim_gen)
      return activated !== undefined && claimed !== undefined && activated > claimed
        ? activated - claimed
        : 0n
    }
    case 'generation/negative-claim': {
      const value = exactInteger(run?.claim_gen)
      return value !== undefined && value < 0n ? -value : 0n
    }
    case 'generation/negative-relaunch': {
      const value = exactInteger(run?.relaunch_count)
      return value !== undefined && value < 0n ? -value : 0n
    }
    case 'generation/negative-attempts': {
      const value = exactInteger(task?.attempts)
      return value !== undefined && value < 0n ? -value : 0n
    }
    case 'generation/negative-infra-retries': {
      const value = exactInteger(task?.infra_retries)
      return value !== undefined && value < 0n ? -value : 0n
    }
    case 'cardinality/multiple-live-runs':
    case 'cardinality/live-task-multiple-runs': {
      const count = BigInt(liveRuns(snapshot, primarySubject).length)
      return count > 1n ? count - 1n : 0n
    }
    case 'cardinality/live-task-zero-runs':
    case 'mirror/running-task-no-live-run':
      return liveRuns(snapshot, primarySubject).length === 0 ? 1n : 0n
    case 'terminal-task/live-run':
      return BigInt(liveRuns(snapshot, primarySubject).length)
    case 'wait/deadlines-differ': {
      const [runId, stepName] = finding.subjectIdentity
      const wait = snapshot.waits.find(
        (candidate) => candidate.run_id === runId && candidate.step_name === stepName,
      )
      const deadline = exactInteger(wait?.timeout_at_ms)
      const available = exactInteger(rowById(snapshot, 'runs', runId ?? '')?.available_at_ms)
      if (deadline === undefined || available === undefined) return 0n
      return deadline >= available ? deadline - available : available - deadline
    }
    case 'provenance/one-seed-two-instants': {
      const seed = finding.subjectIdentity[0]
      const instants = [
        ...snapshot.tasks,
        ...snapshot.runs,
        ...snapshot.events,
        ...snapshot.waits,
      ].flatMap((row) => {
        if (typeof row.fence_stamp !== 'string') return []
        const parsed = parseFenceStamp(row.fence_stamp)
        if (!parsed.ok || parsed.seed !== seed) return []
        const instant = exactInteger(row.fence_at_ms)
        return instant === undefined ? [] : [instant]
      })
      const distinct = [...new Set(instants)]
      if (distinct.length < 2) return 0n
      const minimum = distinct.reduce((lowest, value) => (value < lowest ? value : lowest))
      const maximum = distinct.reduce((highest, value) => (value > highest ? value : highest))
      return maximum - minimum
    }
    default:
      return 1n
  }
}

function findingKey(finding: EngineInvariantFinding): string {
  return JSON.stringify([finding.conditionId, finding.subjectIdentity])
}

function worsenedFindings(
  beforeFindings: readonly EngineInvariantFinding[],
  afterFindings: readonly EngineInvariantFinding[],
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
): string[] {
  const prior = new Map(beforeFindings.map((finding) => [findingKey(finding), finding]))
  const worsened: string[] = []
  for (const finding of afterFindings) {
    const old = prior.get(findingKey(finding))
    if (!old) continue
    const oldSeverity = findingSeverity(old, before)
    const newSeverity = findingSeverity(finding, after)
    if (newSeverity > oldSeverity) {
      worsened.push(
        `${finding.conditionId} on ${finding.subject} worsened from ${oldSeverity} to ${newSeverity}`,
      )
    }
  }
  return worsened
}

function checkpointByName(
  snapshot: ProtocolSnapshot,
  taskId: string,
  name: string,
): SqlRow | undefined {
  return snapshot.checkpoints.find((row) => row.task_id === taskId && row.checkpoint_name === name)
}

function hasOutcome(
  outcomes: readonly PoisonInvocationOutcome[],
  predicate: (result: unknown) => boolean,
): boolean {
  return outcomes.some((outcome) => outcome.status === 'fulfilled' && predicate(outcome.result))
}

function outcomeItems(outcomes: readonly PoisonInvocationOutcome[]): Record<string, unknown>[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' && Array.isArray(outcome.result)
      ? outcome.result
          .map(object)
          .filter((item): item is Record<string, unknown> => item !== undefined)
      : [],
  )
}

function counterValue(before: ProtocolSnapshot, field: PersistedCounterFieldDescriptor): unknown {
  if (field.table === 'tasks') return rowById(before, 'tasks', TASK)?.[field.column]
  if (field.table === 'runs') return rowById(before, 'runs', RUN)?.[field.column]
  return undefined
}

function exactWithin(value: unknown, bounds: IntegerBounds): boolean {
  const exact = exactInteger(value)
  return exact !== undefined && exact >= BigInt(bounds.min) && exact <= BigInt(bounds.max)
}

function orderedBefore(
  leftTime: bigint,
  leftId: string,
  rightTime: bigint,
  rightId: string,
): boolean {
  return leftTime < rightTime || (leftTime === rightTime && leftId < rightId)
}

function declaredTargetErrors(
  profile: PoisonTargetProfile,
  before: ProtocolSnapshot,
  witness: PoisonWitness,
  requireHealthyOrdering: boolean,
): string[] {
  const errors: string[] = []
  const task = rowById(before, 'tasks', TASK)
  const run = rowById(before, 'runs', RUN)
  const healthyRun = rowById(before, 'runs', TRIGGER_RUN)
  const expectedState =
    profile === 'claim-pending' ? 'pending' : profile === 'claim-sleeping' ? 'sleeping' : 'running'
  if (task?.state !== expectedState || run?.state !== expectedState) {
    errors.push(`declared ${profile} lifecycle was not applied`)
  }
  if (
    task?.queue !== Q ||
    run?.queue !== Q ||
    run?.task_id !== TASK ||
    liveRuns(before, TASK).length !== 1
  ) {
    errors.push(`declared ${profile} owner closure is not uniquely eligible`)
  }
  const cancelAt = task?.cancel_at_ms
  if (
    cancelAt !== null &&
    (exactInteger(cancelAt) === undefined || (exactInteger(cancelAt) as bigint) <= BigInt(NOW))
  ) {
    errors.push(`declared ${profile} task is already cancellation-due`)
  }

  const attempt = exactInteger(run?.attempt)
  const attempts = exactInteger(task?.attempts)
  const maximum = exactInteger(task?.max_attempts)
  const infra = exactInteger(task?.infra_retries)
  const claimGen = exactInteger(run?.claim_gen)
  const activatedGen = exactInteger(run?.activated_gen)
  const targetFieldId = witness.counterBoundary?.fieldId ?? witness.targetNonExactField
  for (const field of PERSISTED_COUNTER_FIELDS) {
    if (field.table === 'checkpoints' || field.id === targetFieldId) continue
    if (!exactWithin(counterValue(before, field), field.bounds)) {
      errors.push(`declared ${profile} has unrelated invalid counter ${field.id}`)
    }
  }
  if (witness.targetNonExactField) {
    const field = persistedCounterField(witness.targetNonExactField)
    const value = counterValue(before, field)
    if (
      typeof value !== 'number' ||
      Number.isInteger(value) ||
      value < field.bounds.min ||
      value > field.bounds.max
    ) {
      errors.push(`declared ${profile} fractional target is not in-range REAL data`)
    }
  }
  const allowsNonExactMaximum = witness.targetNonExactField === 'task-max-attempts'
  const allowsExhaustedBudget = witness.covers.includes('attempts/at-max-with-live-run')
  const allowsAccountingMismatch = witness.covers.includes('accounting/live-run-not-next')
  if (
    attempt === undefined ||
    attempts === undefined ||
    (maximum === undefined && !allowsNonExactMaximum) ||
    infra === undefined ||
    (maximum !== undefined && attempts >= maximum && !allowsExhaustedBudget) ||
    (attempt !== attempts + infra + 1n && !allowsAccountingMismatch)
  ) {
    errors.push(`declared ${profile} counter companions do not isolate one boundary`)
  }
  if (
    !witness.covers.includes('accounting/below-top-minus-one') &&
    attempt !== undefined &&
    before.runs.some(
      (candidate) =>
        candidate.task_id === TASK &&
        exactInteger(candidate.attempt) !== undefined &&
        (exactInteger(candidate.attempt) as bigint) > attempt,
    )
  ) {
    errors.push(`declared ${profile} has an unrelated higher owned ordinal`)
  }

  if (profile === 'claim-pending' || profile === 'claim-sleeping') {
    const available = exactInteger(run?.available_at_ms)
    if (
      run?.claimed_by !== null ||
      run?.claim_expires_at_ms !== null ||
      available === undefined ||
      available > BigInt(NOW)
    ) {
      errors.push(`declared ${profile} run is not a due unclaimed candidate`)
    }
    if (
      claimGen === undefined ||
      activatedGen === undefined ||
      activatedGen > claimGen ||
      (targetFieldId !== 'run-claim-gen' &&
        claimGen >= BigInt(PERSISTED_INTEGER_BOUNDS.runs.claim_gen.max))
    ) {
      errors.push(`declared ${profile} generation tuple has an unrelated claim refusal`)
    }
    if (run?.wake_step === null && typeof run.wake_event === 'string') {
      const matchingWaits = before.waits.filter(
        (wait) =>
          wait.run_id === RUN &&
          wait.queue === Q &&
          wait.task_id === TASK &&
          wait.event_name === run.wake_event &&
          wait.status === 'waiting' &&
          wait.timeout_at_ms === run.available_at_ms,
      )
      if (matchingWaits.length > 1) {
        errors.push(`declared ${profile} has an unrelated ambiguous wait registration`)
      }
    }
    const healthyAvailable = exactInteger(healthyRun?.available_at_ms)
    if (
      requireHealthyOrdering &&
      (available === undefined ||
        healthyAvailable === undefined ||
        !orderedBefore(available, RUN, healthyAvailable, TRIGGER_RUN))
    ) {
      errors.push(`declared ${profile} poison does not sort before the healthy trigger`)
    }
    return errors
  }

  const expires = exactInteger(run?.claim_expires_at_ms)
  if (
    run?.claimed_by !== TOKEN ||
    expires === undefined ||
    expires > BigInt(NOW) ||
    claimGen === undefined ||
    activatedGen === undefined
  ) {
    errors.push(`declared ${profile} run is not an expired owned claim`)
    return errors
  }
  if (profile === 'sweep-lost-launch' && activatedGen >= claimGen) {
    errors.push('declared lost-launch target is not pre-activation')
  }
  if (profile === 'sweep-claim-timeout' && activatedGen !== claimGen) {
    errors.push('declared claim-timeout target is not post-activation')
  }
  if (
    targetFieldId !== 'run-claim-gen' &&
    (claimGen < 1n || claimGen > BigInt(PERSISTED_INTEGER_BOUNDS.runs.claim_gen.max))
  ) {
    errors.push(`declared ${profile} claim generation has an unrelated sweep refusal`)
  }
  const healthyExpires = exactInteger(healthyRun?.claim_expires_at_ms)
  if (
    requireHealthyOrdering &&
    (healthyExpires === undefined || !orderedBefore(expires, RUN, healthyExpires, TRIGGER_RUN))
  ) {
    errors.push(`declared ${profile} poison does not sort before the healthy trigger`)
  }
  return errors
}

function poisonOwnedClosure(snapshot: ProtocolSnapshot): Record<string, readonly SqlRow[]> {
  const runs = snapshot.runs.filter((row) => row.task_id === TASK)
  const runIds = new Set(runs.map((row) => String(row.run_id)))
  return {
    tasks: snapshot.tasks.filter((row) => row.task_id === TASK),
    runs,
    waits: snapshot.waits.filter((row) => row.task_id === TASK || runIds.has(String(row.run_id))),
    checkpoints: snapshot.checkpoints.filter(
      (row) => row.task_id === TASK || runIds.has(String(row.owner_run_id)),
    ),
  }
}

function outcomeMentionsPoison(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(outcomeMentionsPoison)
  const item = object(value)
  if (!item) return false
  if (item.taskId === TASK || item.runId === RUN) return true
  return Object.values(item).some((candidate) =>
    Array.isArray(candidate) ? candidate.some(outcomeMentionsPoison) : false,
  )
}

function poisonTargetErrors(
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
  outcomes: readonly PoisonInvocationOutcome[],
): string[] {
  const errors: string[] = []
  if (!same(poisonOwnedClosure(before), poisonOwnedClosure(after))) {
    errors.push('targeted poison-owned closure changed')
  }
  if (
    outcomes.some(
      (outcome) => outcome.status === 'fulfilled' && outcomeMentionsPoison(outcome.result),
    )
  ) {
    errors.push('targeted operation returned the poison task or run')
  }
  return errors
}

function healthyWinErrors(
  label: string,
  after: ProtocolSnapshot,
  outcomes: readonly PoisonInvocationOutcome[],
  responsibleTarget: PoisonInvocationTarget,
): string[] {
  const errors: string[] = []
  const task = rowById(after, 'tasks', TRIGGER_TASK)
  const run = rowById(after, 'runs', TRIGGER_RUN)
  const healthy = outcomes.filter((outcome) => outcome.target === 'healthy')
  const expect = (condition: boolean, message: string): void => {
    if (!condition) errors.push(`healthy trigger did not win: ${message}`)
  }
  if (
    outcomes.some(
      (outcome) => outcome.target === responsibleTarget && outcome.status === 'rejected',
    )
  ) {
    errors.push('healthy trigger did not win: invocation rejected')
  }
  switch (label) {
    case 'driver-heartbeat': {
      const driver = after.drivers.find(
        (row) => row.queue === Q && row.driver_id === TRIGGER_DRIVER,
      )
      expect(
        same(driver?.last_beat_ms, NOW) && same(driver?.expires_at_ms, NOW + 30_000),
        'driver heartbeat row was not written',
      )
      break
    }
    case 'spawn': {
      const result = healthy
        .flatMap((outcome) => (outcome.status === 'fulfilled' ? [object(outcome.result)] : []))
        .find((value) => value?.created === true)
      const spawnedTask =
        typeof result?.taskId === 'string' ? rowById(after, 'tasks', result.taskId) : undefined
      const spawnedRun =
        typeof result?.runId === 'string' ? rowById(after, 'runs', result.runId) : undefined
      expect(
        Boolean(
          result &&
            spawnedTask?.state === 'pending' &&
            spawnedRun?.task_id === result.taskId &&
            spawnedRun?.state === 'pending' &&
            same(spawnedRun?.attempt, 1),
        ),
        'spawn did not return and persist a new task/run pair',
      )
      break
    }
    case 'claim': {
      const claimed = outcomeItems(outcomes).find((item) => item.runId === TRIGGER_RUN)
      expect(
        Boolean(
          claimed &&
            task?.state === 'running' &&
            run?.state === 'running' &&
            run.claimed_by === claimed.claimToken &&
            same(run.claim_gen, 1),
        ),
        'due trigger run was not claimed',
      )
      break
    }
    case 'activate':
      expect(
        hasOutcome(healthy, (result) => object(result)?.runId === TRIGGER_RUN) &&
          same(run?.activated_gen, 1) &&
          same(run?.started_at_ms, NOW),
        'trigger claim was not activated',
      )
      break
    case 'defer-launch':
      expect(
        task?.state === 'sleeping' &&
          run?.state === 'sleeping' &&
          same(run.available_at_ms, NOW + 1_000) &&
          same(run.activated_gen, 0) &&
          run.claimed_by === null,
        'trigger launch was not deferred',
      )
      break
    case 'heartbeat':
      expect(
        hasOutcome(healthy, (result) => object(result)?.held === true) &&
          same(run?.heartbeat_at_ms, NOW) &&
          same(run?.claim_expires_at_ms, NOW + 60_000),
        'trigger lease was not extended',
      )
      break
    case 'reschedule':
      expect(
        task?.state === 'sleeping' &&
          run?.state === 'sleeping' &&
          same(run.available_at_ms, NOW + 1_000) &&
          run.claimed_by === null,
        'trigger run was not rescheduled',
      )
      break
    case 'suspend': {
      const marker = checkpointByName(after, TRIGGER_TASK, 'trigger-sleep')
      expect(
        task?.state === 'sleeping' &&
          run?.state === 'sleeping' &&
          same(run.available_at_ms, NOW + 1_000) &&
          marker?.owner_run_id === TRIGGER_RUN,
        'trigger run and marker were not suspended atomically',
      )
      break
    }
    case 'emit-event': {
      const fired = after.events.find((row) => row.queue === Q && row.event_name === TRIGGER_EVENT)
      const wait = after.waits.find(
        (row) => row.run_id === TRIGGER_RUN && row.step_name === TRIGGER_STEP,
      )
      expect(
        Boolean(
          fired &&
            !wait &&
            task?.state === 'pending' &&
            run?.state === 'pending' &&
            run.event_payload === '{"healthy":true}',
        ),
        'trigger event did not wake and consume its wait',
      )
      break
    }
    case 'await-event': {
      const wait = after.waits.find(
        (row) => row.run_id === TRIGGER_RUN && row.step_name === TRIGGER_STEP,
      )
      expect(
        hasOutcome(healthy, (result) => object(result)?.emitted === false) &&
          task?.state === 'sleeping' &&
          run?.state === 'sleeping' &&
          same(run.available_at_ms, NOW + 30_000) &&
          wait?.event_name === TRIGGER_EVENT &&
          same(wait.timeout_at_ms, NOW + 30_000),
        'trigger wait was not registered and parked',
      )
      break
    }
    case 'record-task-done':
      expect(
        hasOutcome(healthy, (result) => object(result)?.emitted === true) &&
          run?.state === 'running' &&
          after.events.some(
            (row) => row.queue === Q && row.event_name === taskDoneEventName(TRIGGER_ENDED_CHILD),
          ),
        "trigger await did not record the ended child's outcome",
      )
      break
    case 'complete':
      expect(
        task?.state === 'completed' &&
          run?.state === 'completed' &&
          task.completed_payload === '{"healthy":true}',
        'trigger run was not completed',
      )
      break
    case 'fail':
      expect(
        task?.state === 'failed' && same(task.attempts, 1) && run?.state === 'failed',
        'trigger run was not failed terminally',
      )
      break
    case 'fail-rollback':
      expect(
        task?.state === 'failed' &&
          same(task.attempts, 1) &&
          run?.state === 'failed' &&
          after.checkpoints.some(
            (row) => row.task_id === TRIGGER_TASK && row.checkpoint_name === ROLLBACK_TRIED,
          ),
        'trigger rollback did not fail for good with its attempt recorded',
      )
      break
    case 'retry-task':
      expect(
        hasOutcome(healthy, (result) => same(object(result)?.attempt, 2)) &&
          task?.state === 'pending' &&
          same(task.max_attempts, 2) &&
          run?.state === 'failed',
        'trigger task was not revived',
      )
      break
    case 'cancel-task':
      expect(
        hasOutcome(healthy, (result) => result === true) &&
          task?.state === 'cancelled' &&
          run?.state === 'cancelled',
        'trigger task was not cancelled',
      )
      break
    case 'expire-lease-now':
      expect(
        hasOutcome(healthy, (result) => result === true) && same(run?.claim_expires_at_ms, NOW),
        'trigger lease was not expired to database now',
      )
      break
    case 'set-checkpoint': {
      const saved = checkpointByName(after, TRIGGER_TASK, 'trigger-checkpoint')
      expect(
        saved?.owner_run_id === TRIGGER_RUN &&
          same(run?.heartbeat_at_ms, NOW) &&
          same(run?.claim_expires_at_ms, NOW + 60_000),
        'trigger checkpoint and lease extension were not committed',
      )
      break
    }
    case 'sweep:cancel':
      expect(
        outcomeItems(outcomes).some(
          (item) => item.kind === 'cancelled' && item.taskId === TRIGGER_TASK,
        ) &&
          task?.state === 'cancelled' &&
          run?.state === 'cancelled',
        'due trigger task was not swept cancelled',
      )
      break
    case 'sweep:lost-launch':
      expect(
        outcomeItems(outcomes).some(
          (item) => item.kind === 'lost-launch' && item.runId === TRIGGER_RUN,
        ) &&
          task?.state === 'pending' &&
          run?.state === 'pending' &&
          same(run.relaunch_count, 1),
        'lost launch trigger was not reopened',
      )
      break
    case 'sweep:claim-timeout': {
      const result = outcomeItems(outcomes).find(
        (item) => item.kind === 'claim-timeout' && item.runId === TRIGGER_RUN,
      )
      const successor =
        typeof result?.successorRunId === 'string'
          ? rowById(after, 'runs', result.successorRunId)
          : undefined
      expect(
        Boolean(
          result &&
            task?.state === 'pending' &&
            same(task.infra_retries, 1) &&
            run?.state === 'failed' &&
            successor?.task_id === TRIGGER_TASK &&
            successor.state === 'pending' &&
            same(successor.attempt, 2),
        ),
        'timed-out trigger claim did not create its returned successor',
      )
      break
    }
  }
  return errors
}

function newFindings(
  label: string,
  before: readonly EngineInvariantFinding[],
  after: readonly EngineInvariantFinding[],
): string[] {
  const old = new Set(before.map(findingKey))
  return after
    .filter((item) => !old.has(findingKey(item)))
    .filter(
      (item) =>
        !(
          label === 'emit-event' &&
          item.conditionId === 'wait/fired-event' &&
          item.subjectIdentity[0] === RUN
        ),
    )
    .map((item) => item.message)
}

interface PoisonCaseResultIdentity {
  readonly label: string
  readonly witness: string
  readonly profile?: PoisonTargetProfile
}

interface ExecutedPoisonCaseResult extends PoisonCaseResultIdentity {
  readonly invocation: PoisonInvocationOutcome<'poison'>
  readonly poisonSubjectUnchanged: boolean
  readonly corruptionDisposition: 'injected'
}

interface StructurallyRejectedPoisonCaseResult extends PoisonCaseResultIdentity {
  readonly invocation: null
  readonly corruptionDisposition: 'structurally-rejected'
}

export type PoisonCaseResult = ExecutedPoisonCaseResult | StructurallyRejectedPoisonCaseResult

export interface PoisonCaseOptions {
  /**
   * Test-only switch used to prove the progress floor rejects a label whose
   * corrupt-target call is a no-op. Normal generated cells leave this true.
   */
  healthyTrigger?: boolean
  /** Generated branch-reachable counter containment profile. */
  targetProfile?: PoisonTargetProfile
  targetCompanions?: CounterSeedOverrides
  /** Test-only result hook proving the returned-target oracle is live. */
  afterOutcomes?(outcomes: PoisonInvocationOutcome[]): void
  /** Test-only corruption hooks for oracle self-tests. */
  beforeSnapshot?(raw: SqlExecutor): Promise<void>
  afterInvoke?(raw: SqlExecutor): Promise<void>
}

interface PreparedPoisonCase {
  readonly caseName: string
  readonly fixture: StoreFixture
  readonly corruptionDisposition: StorageCorruptionDisposition
  readonly beforeFindings: readonly EngineInvariantFinding[]
}

async function preparePoisonCase(
  makeFixture: StoreFixtureFactory,
  label: (typeof MATRIX_WRITE_LABELS)[number],
  witness: PoisonWitness,
  options: PoisonCaseOptions,
): Promise<PreparedPoisonCase> {
  const caseName = `${label}-${witness.id}${options.targetProfile ? `-${options.targetProfile}` : ''}`
  const fixture = await makeFixture(`poison-${caseName}`)
  try {
    await seedBase(fixture)
    if (options.targetProfile) {
      await preparePoisonTarget(fixture.raw, options.targetProfile, options.targetCompanions ?? {})
    }
    if (witness.statements.length > 0) {
      await fixture.raw.batch('poison:corrupt', witness.statements, 'write')
    }
    const corruptionDisposition = witness.storageCorruption
      ? await executeStorageCorruption(fixture, witness.storageCorruption)
      : 'injected'
    if (corruptionDisposition === 'structurally-rejected') {
      return {
        caseName,
        fixture,
        corruptionDisposition,
        beforeFindings: [],
      }
    }
    if (options.healthyTrigger !== false) await seedHealthyTrigger(fixture.raw, label)
    await options.beforeSnapshot?.(fixture.raw)

    const beforeFindings = await engineInvariantFindings(fixture.raw)
    return { caseName, fixture, corruptionDisposition, beforeFindings }
  } catch (error) {
    await fixture.close()
    throw error
  }
}

export interface PoisonAggregateWitnessObservation {
  readonly label: (typeof MATRIX_WRITE_LABELS)[number]
  readonly witness: PoisonAggregateWitnessId
  readonly profile?: PoisonTargetProfile
  readonly conditionIds: readonly EngineInvariantConditionId[]
  readonly corruptionDisposition: StorageCorruptionDisposition
}

async function observePoisonAggregateWitnessCase(
  makeFixture: StoreFixtureFactory,
  label: (typeof MATRIX_WRITE_LABELS)[number],
  witnessId: PoisonAggregateWitnessId,
  options: Pick<PoisonCaseOptions, 'targetProfile' | 'targetCompanions'>,
): Promise<PoisonAggregateWitnessObservation> {
  const witness = requiredPoisonWitness(witnessId)
  const prepared = await preparePoisonCase(makeFixture, label, witness, options)
  try {
    return {
      label,
      witness: witnessId,
      ...(options.targetProfile ? { profile: options.targetProfile } : {}),
      conditionIds: prepared.beforeFindings.map(({ conditionId }) => conditionId),
      corruptionDisposition: prepared.corruptionDisposition,
    }
  } finally {
    await prepared.fixture.close()
  }
}

export function observePoisonAggregateAmbientCase(
  makeFixture: StoreFixtureFactory,
  label: (typeof MATRIX_WRITE_LABELS)[number],
  witnessId: PoisonAggregateWitnessId,
): Promise<PoisonAggregateWitnessObservation> {
  return observePoisonAggregateWitnessCase(makeFixture, label, witnessId, {})
}

export function observePoisonAggregateTargetCase(
  makeFixture: StoreFixtureFactory,
  target: PoisonTargetCase,
): Promise<PoisonAggregateWitnessObservation> {
  if (!aggregateOwnsWitness(target.witness)) {
    throw new Error(`poison target '${target.id}' has no aggregate witness owner`)
  }
  return observePoisonAggregateWitnessCase(makeFixture, target.label, target.witness.id, {
    targetProfile: target.profile,
    targetCompanions: target.companions,
  })
}

/**
 * One generated label x corrupt-pre-state cell. The operation may refuse the
 * corrupt target; refusal is safe only when the labeled batch really ran and
 * the state audit proves it neither spread nor laundered the poison.
 */
export async function runPoisonMatrixCase(
  makeFixture: StoreFixtureFactory,
  label: (typeof MATRIX_WRITE_LABELS)[number],
  witness: PoisonWitness,
  options: PoisonCaseOptions = {},
): Promise<PoisonCaseResult> {
  const prepared = await preparePoisonCase(makeFixture, label, witness, options)
  const { caseName, fixture: f, corruptionDisposition, beforeFindings } = prepared
  try {
    if (corruptionDisposition === 'structurally-rejected') {
      return {
        label,
        witness: witness.id,
        ...(options.targetProfile ? { profile: options.targetProfile } : {}),
        invocation: null,
        corruptionDisposition,
      }
    }
    if (!aggregateOwnsWitness(witness)) {
      for (const expected of witness.covers) {
        if (!beforeFindings.some((item) => item.conditionId === expected)) {
          throw new Error(
            `${label}/${witness.id}: witness did not fire '${expected}'; got ${beforeFindings
              .map((item) => `${item.conditionId} (${item.message})`)
              .join('; ')}`,
          )
        }
      }
    }
    const before = await snapshot(f.raw)
    if (options.targetProfile) {
      const targetErrors = declaredTargetErrors(
        options.targetProfile,
        before,
        witness,
        options.healthyTrigger !== false,
      )
      if (targetErrors.length > 0) {
        throw new Error(`${caseName}: ${targetErrors.join('; ')}`)
      }
    }
    const frozenAuthority = freezeAuthority(before)
    const recorder = new RecordingExecutor(f.raw)
    const store = f.storeOver(recorder)
    const outcomes: PoisonInvocationOutcome[] = []
    const call = async <Target extends PoisonInvocationTarget>(
      target: Target,
      invokeTarget: () => Promise<unknown>,
    ): Promise<PoisonInvocationOutcome<Target>> => {
      try {
        const result = await invokeTarget()
        return Object.freeze({ target, status: 'fulfilled', result })
      } catch (reason) {
        return Object.freeze({ target, status: 'rejected', reason })
      }
    }
    const targetedSelection = options.targetProfile !== undefined
    outcomes.push(
      await call('poison', () =>
        invoke(label, store, POISON_INVOCATION, targetedSelection ? 1 : 100),
      ),
    )
    if (options.healthyTrigger !== false && !targetedSelection) {
      outcomes.push(await call('healthy', () => invoke(label, store, HEALTHY_INVOCATION)))
    }
    options.afterOutcomes?.(outcomes)
    try {
      // Hooks deliberately run outside the recorder: oracle self-tests must
      // not be able to satisfy the progress floor with their own mutation.
      await options.afterInvoke?.(f.raw)
    } catch (error) {
      throw new Error(`${label}/${witness.id}: after-invoke hook failed`, { cause: error })
    }
    if (!recorder.labels.includes(label)) {
      throw new Error(
        `${label}/${witness.id}: driver did not fire label; saw ${recorder.labels.join(', ')}`,
      )
    }
    if (!recorder.changedDurableState(label)) {
      throw new Error(
        `${label}/${witness.id}: label crossed executor but made no durable state change`,
      )
    }

    const after = await snapshot(f.raw)
    const afterFindings = await engineInvariantFindings(f.raw)
    const inserts = explicitInsertAuthority(label, before, outcomes)
    const errors = [
      ...changedOutsideAuthority(before, after, frozenAuthority, inserts).map(
        (row) => `write escaped authority: ${row}`,
      ),
      ...terminalBarrier(label, before, after),
      ...completionEventBarrier(label, before, after),
      ...(witness.inertLive ? inertLiveBarrier(label, before, after) : []),
      ...newFindings(label, beforeFindings, afterFindings).map(
        (item) => `new invariant violation: ${item}`,
      ),
      ...worsenedFindings(beforeFindings, afterFindings, before, after),
      ...(options.healthyTrigger === false
        ? []
        : healthyWinErrors(label, after, outcomes, targetedSelection ? 'poison' : 'healthy')),
      ...(options.targetProfile ? poisonTargetErrors(before, after, outcomes) : []),
    ]
    if (liveRuns(after, TASK).length > liveRuns(before, TASK).length) {
      errors.push('poisoned task gained live-run cardinality')
    }
    if (errors.length > 0) {
      throw new Error(`${label}/${witness.id}: ${errors.join('; ')}`)
    }
    const poisonOutcome = outcomes.find(
      (outcome): outcome is PoisonInvocationOutcome<'poison'> => outcome.target === 'poison',
    )
    if (!poisonOutcome)
      throw new Error(`${label}/${witness.id}: poison invocation was not recorded`)
    return {
      label,
      witness: witness.id,
      ...(options.targetProfile ? { profile: options.targetProfile } : {}),
      invocation: poisonOutcome,
      poisonSubjectUnchanged: same(poisonOwnedClosure(before), poisonOwnedClosure(after)),
      corruptionDisposition,
    }
  } finally {
    await f.close()
  }
}

export function runPoisonTargetCase(
  makeFixture: StoreFixtureFactory,
  target: PoisonTargetCase,
  options: Omit<PoisonCaseOptions, 'targetProfile' | 'targetCompanions'> = {},
): Promise<PoisonCaseResult> {
  return runPoisonMatrixCase(makeFixture, target.label, target.witness, {
    ...options,
    targetProfile: target.profile,
    targetCompanions: target.companions,
  })
}

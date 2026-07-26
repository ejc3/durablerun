import {
  MAX_COUNT,
  MAX_DURATION_MS,
  MAX_EPOCH_MS,
  MAX_RUN_ORDINAL,
  type SchedulerStore,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  isLiveState,
  isTerminalState,
  parseFenceStamp,
} from '@durablerun/core'
import { MATRIX_WRITE_LABELS } from './fault-matrix.js'
import type {
  StorageCorruption,
  StorageCorruptionDisposition,
  StoreFixture,
  StoreFixtureFactory,
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

export interface PoisonWitness {
  id: string
  covers: readonly EngineInvariantConditionId[]
  statements: readonly SqlStatement[]
  storageCorruption?: StorageCorruption
  inertLive?: true
}

const sql = (
  text: string,
  args: ReadonlyArray<string | number | bigint | Uint8Array | null> = [],
): SqlStatement => ({ sql: text, args })

const taskState = (state: string): SqlStatement =>
  sql(`UPDATE tasks SET state = ? WHERE task_id = ?`, [state, TASK])

const runState = (state: string): SqlStatement =>
  sql(
    `UPDATE runs SET state = ?, claimed_by = CASE WHEN ? = 'running' THEN ? ELSE NULL END,
       claim_expires_at_ms = CASE WHEN ? = 'running' THEN ? ELSE NULL END
     WHERE run_id = ?`,
    [state, state, TOKEN, state, NOW + 60_000, RUN],
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
): SqlStatement =>
  sql(
    `INSERT INTO checkpoints
       (task_id, checkpoint_name, queue, state, status, owner_run_id, owner_attempt, updated_at_ms)
     VALUES (?, 'poison-checkpoint', ?, '{}', 'committed', ?, 1, ?)`,
    [taskId, queue, ownerRunId, updatedAt],
  )

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
    statements: [taskState('completed')],
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
    id: 'accounting/above-top',
    covers: ['accounting/above-top'],
    statements: [sql(`UPDATE tasks SET attempts = 2 WHERE task_id = ?`, [TASK])],
  },
  {
    id: 'accounting/below-top-minus-one',
    covers: ['accounting/below-top-minus-one'],
    statements: [sql(`UPDATE runs SET attempt = 3 WHERE run_id = ?`, [RUN])],
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
    id: 'wait/dead-run',
    covers: ['wait/dead-run'],
    statements: [
      taskState('completed'),
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
  ...(
    [
      [
        'run-available',
        {
          table: 'runs',
          runId: RUN,
          column: 'available_at_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-claim-expires',
        {
          table: 'runs',
          runId: RUN,
          column: 'claim_expires_at_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-heartbeat',
        {
          table: 'runs',
          runId: RUN,
          column: 'heartbeat_at_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-created',
        {
          table: 'runs',
          runId: RUN,
          column: 'created_at_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-lease',
        {
          table: 'runs',
          runId: RUN,
          column: 'lease_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'task-enqueue',
        {
          table: 'tasks',
          taskId: TASK,
          column: 'enqueue_at_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'task-cancel',
        {
          table: 'tasks',
          taskId: TASK,
          column: 'cancel_at_ms',
          invalidRepresentation: 'non-integer',
        },
      ],
    ] as const
  ).map(
    ([id, storageCorruption]): PoisonWitness => ({
      id: `temporal/${id}`,
      covers: [`temporal/${id}` as EngineInvariantConditionId],
      statements: [],
      storageCorruption,
    }),
  ),
  {
    id: 'temporal/checkpoint-updated',
    covers: ['temporal/checkpoint-updated'],
    statements: [checkpoint(TASK, Q, RUN)],
    storageCorruption: {
      table: 'checkpoints',
      taskId: TASK,
      checkpointName: 'poison-checkpoint',
      column: 'updated_at_ms',
      invalidRepresentation: 'non-integer',
    },
  },
  ...(
    [
      ['run-available', 'runs', 'available_at_ms', RUN, MAX_EPOCH_MS],
      ['run-claim-expires', 'runs', 'claim_expires_at_ms', RUN, MAX_EPOCH_MS],
      ['run-heartbeat', 'runs', 'heartbeat_at_ms', RUN, MAX_EPOCH_MS],
      ['run-created', 'runs', 'created_at_ms', RUN, MAX_EPOCH_MS],
      ['run-lease', 'runs', 'lease_ms', RUN, MAX_DURATION_MS],
      ['task-enqueue', 'tasks', 'enqueue_at_ms', TASK, MAX_EPOCH_MS],
      ['task-cancel', 'tasks', 'cancel_at_ms', TASK, MAX_EPOCH_MS],
    ] as const
  ).map(
    ([id, table, column, rowId, maximum]): PoisonWitness => ({
      id: `temporal-bound/${id}`,
      covers: [`temporal-bound/${id}` as EngineInvariantConditionId],
      statements: [
        sql(
          `UPDATE ${table} SET ${column} = ? WHERE ${table === 'runs' ? 'run_id' : 'task_id'} = ?`,
          [maximum + 1, rowId],
        ),
      ],
    }),
  ),
  {
    id: 'temporal-bound/checkpoint-updated',
    covers: ['temporal-bound/checkpoint-updated'],
    statements: [
      checkpoint(TASK, Q, RUN),
      sql(
        `UPDATE checkpoints SET updated_at_ms = ?
         WHERE task_id = ? AND checkpoint_name = 'poison-checkpoint'`,
        [MAX_EPOCH_MS + 1, TASK],
      ),
    ],
  },
  ...(
    [
      [
        'task-attempts',
        {
          table: 'tasks',
          taskId: TASK,
          column: 'attempts',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'task-max-attempts',
        {
          table: 'tasks',
          taskId: TASK,
          column: 'max_attempts',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'task-infra-retries',
        {
          table: 'tasks',
          taskId: TASK,
          column: 'infra_retries',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-attempt',
        {
          table: 'runs',
          runId: RUN,
          column: 'attempt',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-claim-gen',
        {
          table: 'runs',
          runId: RUN,
          column: 'claim_gen',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-activated-gen',
        {
          table: 'runs',
          runId: RUN,
          column: 'activated_gen',
          invalidRepresentation: 'non-integer',
        },
      ],
      [
        'run-relaunch-count',
        {
          table: 'runs',
          runId: RUN,
          column: 'relaunch_count',
          invalidRepresentation: 'non-integer',
        },
      ],
    ] as const
  ).map(
    ([id, storageCorruption]): PoisonWitness => ({
      id: `counter/${id}`,
      covers: [`counter/${id}` as EngineInvariantConditionId],
      statements: [],
      storageCorruption,
    }),
  ),
  ...(
    [
      ['task-attempts', 'tasks', 'attempts', TASK],
      ['task-max-attempts', 'tasks', 'max_attempts', TASK],
      ['task-infra-retries', 'tasks', 'infra_retries', TASK],
      ['run-attempt', 'runs', 'attempt', RUN, MAX_RUN_ORDINAL],
      ['run-claim-gen', 'runs', 'claim_gen', RUN, MAX_COUNT],
      ['run-activated-gen', 'runs', 'activated_gen', RUN, MAX_COUNT],
      ['run-relaunch-count', 'runs', 'relaunch_count', RUN, MAX_COUNT],
    ] as const
  ).map(
    ([id, table, column, rowId, maximum = MAX_COUNT]): PoisonWitness => ({
      id: `counter-bound/${id}`,
      covers: [`counter-bound/${id}` as EngineInvariantConditionId],
      statements: [
        sql(
          `UPDATE ${table} SET ${column} = ? WHERE ${table === 'runs' ? 'run_id' : 'task_id'} = ?`,
          [maximum + 1, rowId],
        ),
      ],
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
]

export const POISON_WITNESS_COUNT = POISON_WITNESSES.length
/** One source of truth: every classified write label is automatically enrolled. */
export const POISON_WRITE_LABELS = MATRIX_WRITE_LABELS

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
    mode: SqlBatchMode = 'write',
  ): Promise<SqlResult[]> {
    const call: RecordedCall = { label, mode, changedState: false }
    this.calls.push(call)
    const before = mode === 'write' ? await snapshot(this.real) : undefined
    const results = await this.real.batch(label, statements, mode)
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
type ProtocolSnapshot = Record<SnapshotTable, readonly SqlRow[]>
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
            state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
         VALUES (?, ?, 'canary', '{}', '{"kind":"none"}', 1,
                 'completed', 0, 0, ?, ?)`,
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

async function seedHealthyTrigger(raw: SqlExecutor, label: string): Promise<void> {
  if (label === 'driver-heartbeat' || label === 'spawn') return
  let statements: readonly SqlStatement[]
  switch (label) {
    case 'claim':
      statements = [triggerTask('pending'), triggerRun({ state: 'pending', availableAt: NOW })]
      break
    case 'activate':
      statements = [triggerTask('running'), triggerRun({ state: 'running', activatedGen: 0 })]
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
}

async function invoke(
  label: (typeof MATRIX_WRITE_LABELS)[number],
  store: SchedulerStore,
  target: InvocationTarget,
): Promise<unknown> {
  switch (label) {
    case 'driver-heartbeat':
      return store.driverHeartbeat(Q, target.driverId, 30)
    case 'spawn':
      return store.spawn(Q, target.taskName, '{}', { idempotencyKey: target.idempotencyKey })
    case 'claim':
      return store.claim(Q, target.claimWorker, { leaseSeconds: 60, limit: 100 })
    case 'activate':
      return store.activate(Q, target.runId, target.token, 1)
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
    case 'complete':
      return store.complete(Q, target.runId, target.token, target.completionPayload)
    case 'fail':
      return store.fail(Q, target.runId, target.token, target.failure, null)
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
    case 'sweep:cancel':
    case 'sweep:lost-launch':
    case 'sweep:claim-timeout':
      return store.sweep(Q, 100)
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

interface InvocationOutcome {
  target: 'poison' | 'healthy'
  result?: unknown
  error?: unknown
}

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
  outcomes: readonly InvocationOutcome[],
): InsertAuthority {
  const authority = emptyInsertAuthority()
  const poisonAttempt = exactInteger(before.runs.find((run) => run.run_id === RUN)?.attempt) ?? 1n
  if (label === 'driver-heartbeat') {
    for (const driverId of [POISON_DRIVER, TRIGGER_DRIVER]) {
      allowInsert(authority, 'drivers', { queue: Q, driver_id: driverId })
    }
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
  const withoutDeadline = (row: SqlRow): SqlRow =>
    Object.fromEntries(
      Object.entries(row).filter(([name]) => name !== 'claim_expires_at_ms'),
    ) as SqlRow
  return same(withoutDeadline(before), withoutDeadline(after))
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

function inertLiveBarrier(before: ProtocolSnapshot, after: ProtocolSnapshot): string[] {
  const errors: string[] = []
  const beforeRuns = liveRuns(before, TASK)
  const afterRuns = rowsByKey('runs', after.runs)
  const oldIds = new Set(beforeRuns.map((run) => String(run.run_id)))
  for (const run of beforeRuns) {
    const current = afterRuns.get(String(run.run_id))
    if (current && isLiveState(current.state) && !same(run, current)) {
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

function findingSeverity(finding: EngineInvariantFinding, snapshot: ProtocolSnapshot): bigint {
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
  outcomes: readonly InvocationOutcome[],
  predicate: (result: unknown) => boolean,
): boolean {
  return outcomes.some((outcome) => outcome.error === undefined && predicate(outcome.result))
}

function outcomeItems(outcomes: readonly InvocationOutcome[]): Record<string, unknown>[] {
  return outcomes.flatMap((outcome) =>
    Array.isArray(outcome.result)
      ? outcome.result
          .map(object)
          .filter((item): item is Record<string, unknown> => item !== undefined)
      : [],
  )
}

function healthyWinErrors(
  label: string,
  after: ProtocolSnapshot,
  outcomes: readonly InvocationOutcome[],
): string[] {
  const errors: string[] = []
  const task = rowById(after, 'tasks', TRIGGER_TASK)
  const run = rowById(after, 'runs', TRIGGER_RUN)
  const expect = (condition: boolean, message: string): void => {
    if (!condition) errors.push(`healthy trigger did not win: ${message}`)
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
      const result = outcomes
        .filter((outcome) => outcome.target === 'healthy')
        .map((outcome) => object(outcome.result))
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
        hasOutcome(
          outcomes.filter((outcome) => outcome.target === 'healthy'),
          (result) => object(result)?.runId === TRIGGER_RUN,
        ) &&
          same(run?.activated_gen, 1) &&
          same(run?.started_at_ms, NOW),
        'trigger claim was not activated',
      )
      break
    case 'heartbeat':
      expect(
        hasOutcome(
          outcomes.filter((outcome) => outcome.target === 'healthy'),
          (result) => object(result)?.held === true,
        ) &&
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
        hasOutcome(
          outcomes.filter((outcome) => outcome.target === 'healthy'),
          (result) => object(result)?.emitted === false,
        ) &&
          task?.state === 'sleeping' &&
          run?.state === 'sleeping' &&
          same(run.available_at_ms, NOW + 30_000) &&
          wait?.event_name === TRIGGER_EVENT &&
          same(wait.timeout_at_ms, NOW + 30_000),
        'trigger wait was not registered and parked',
      )
      break
    }
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
    case 'cancel-task':
      expect(
        hasOutcome(
          outcomes.filter((outcome) => outcome.target === 'healthy'),
          (result) => result === true,
        ) &&
          task?.state === 'cancelled' &&
          run?.state === 'cancelled',
        'trigger task was not cancelled',
      )
      break
    case 'expire-lease-now':
      expect(
        hasOutcome(
          outcomes.filter((outcome) => outcome.target === 'healthy'),
          (result) => result === true,
        ) && same(run?.claim_expires_at_ms, NOW),
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

export interface PoisonCaseResult {
  label: string
  witness: string
  invocationError: unknown
  corruptionDisposition: StorageCorruptionDisposition
}

export interface PoisonCaseOptions {
  /**
   * Test-only switch used to prove the progress floor rejects a label whose
   * corrupt-target call is a no-op. Normal generated cells leave this true.
   */
  healthyTrigger?: boolean
  /** Test-only corruption hooks for oracle self-tests. */
  beforeSnapshot?(raw: SqlExecutor): Promise<void>
  afterInvoke?(raw: SqlExecutor): Promise<void>
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
  const f = await makeFixture(`poison-${label}-${witness.id}`)
  try {
    await seedBase(f)
    if (witness.statements.length > 0) {
      await f.raw.batch('poison:corrupt', witness.statements, 'write')
    }
    const corruptionDisposition = witness.storageCorruption
      ? await f.injectStorageCorruption(witness.storageCorruption)
      : 'injected'
    if (corruptionDisposition === 'structurally-rejected') {
      return {
        label,
        witness: witness.id,
        invocationError: null,
        corruptionDisposition,
      }
    }
    if (options.healthyTrigger !== false) await seedHealthyTrigger(f.raw, label)
    await options.beforeSnapshot?.(f.raw)

    const beforeFindings = await engineInvariantFindings(f.raw)
    for (const expected of witness.covers) {
      if (!beforeFindings.some((item) => item.conditionId === expected)) {
        throw new Error(
          `${label}/${witness.id}: witness did not fire '${expected}'; got ${beforeFindings
            .map((item) => `${item.conditionId} (${item.message})`)
            .join('; ')}`,
        )
      }
    }
    const before = await snapshot(f.raw)
    const frozenAuthority = freezeAuthority(before)
    const recorder = new RecordingExecutor(f.raw)
    const store = f.storeOver(recorder)
    const outcomes: InvocationOutcome[] = []
    const call = async (
      target: InvocationOutcome['target'],
      invokeTarget: () => Promise<unknown>,
    ): Promise<void> => {
      const outcome: InvocationOutcome = { target }
      outcomes.push(outcome)
      try {
        outcome.result = await invokeTarget()
      } catch (error) {
        outcome.error = error
      }
    }
    await call('poison', () => invoke(label, store, POISON_INVOCATION))
    if (options.healthyTrigger !== false) {
      await call('healthy', () => invoke(label, store, HEALTHY_INVOCATION))
    }
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
      ...(witness.inertLive ? inertLiveBarrier(before, after) : []),
      ...newFindings(label, beforeFindings, afterFindings).map(
        (item) => `new invariant violation: ${item}`,
      ),
      ...worsenedFindings(beforeFindings, afterFindings, before, after),
      ...(options.healthyTrigger === false ? [] : healthyWinErrors(label, after, outcomes)),
    ]
    if (liveRuns(after, TASK).length > liveRuns(before, TASK).length) {
      errors.push('poisoned task gained live-run cardinality')
    }
    if (errors.length > 0) {
      throw new Error(`${label}/${witness.id}: ${errors.join('; ')}`)
    }
    return {
      label,
      witness: witness.id,
      invocationError: outcomes.find((outcome) => outcome.target === 'poison')?.error ?? null,
      corruptionDisposition,
    }
  } finally {
    f.close()
  }
}

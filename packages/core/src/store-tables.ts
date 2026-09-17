import { compileOnlyBuilder } from './sql-tree.js'

type ColumnKind = 'text' | 'integer'

interface ColumnSpec<Kind extends ColumnKind = ColumnKind, Nullable extends boolean = boolean> {
  readonly kind: Kind
  readonly nullable: Nullable
}

const text = { kind: 'text', nullable: false } as const
const nullableText = { kind: 'text', nullable: true } as const
const integer = { kind: 'integer', nullable: false } as const
const nullableInteger = { kind: 'integer', nullable: true } as const

/**
 * The columns statement builders may name, as data. `StoreTables` derives the builder's
 * types from it, so a misspelled column is a type error, and a conformance case compares
 * it with every dialect's catalog, so it cannot drift from the schema.
 *
 * `failure_reason` is here because `fail`, `cancel`, and `retry-task` assign it. The
 * outcome lint still confines reading an outcome to the stores and `decodeTaskResult`,
 * and allows this descriptor and the shared statements to name the column. No tree
 * statement names `tasks.completed_payload` yet, so it stays out. So does
 * `checkpoints.status`, which every checkpoint write leaves to its default.
 */
export const STORE_TABLE_COLUMNS = {
  runs: {
    run_id: text,
    queue: text,
    task_id: text,
    attempt: integer,
    state: text,
    claimed_by: nullableText,
    claim_gen: integer,
    activated_gen: integer,
    relaunch_count: integer,
    lease_ms: nullableInteger,
    claim_expires_at_ms: nullableInteger,
    heartbeat_at_ms: nullableInteger,
    available_at_ms: nullableInteger,
    wake_event: nullableText,
    wake_step: nullableText,
    event_payload: nullableText,
    run_db: nullableText,
    started_at_ms: nullableInteger,
    completed_at_ms: nullableInteger,
    failed_at_ms: nullableInteger,
    failure_reason: nullableText,
    result: nullableText,
    created_at_ms: integer,
    fence_stamp: nullableText,
    fence_at_ms: nullableInteger,
  },
  tasks: {
    task_id: text,
    queue: text,
    task_name: text,
    params: text,
    headers: nullableText,
    retry_strategy: text,
    max_attempts: integer,
    cancellation: nullableText,
    idempotency_key: nullableText,
    state: text,
    attempts: integer,
    infra_retries: integer,
    last_attempt_run: nullableText,
    enqueue_at_ms: integer,
    first_started_at_ms: nullableInteger,
    cancel_at_ms: nullableInteger,
    cancelled_at_ms: nullableInteger,
    failure_reason: nullableText,
    created_at_ms: integer,
    fence_stamp: nullableText,
    fence_at_ms: nullableInteger,
  },
  waits: {
    run_id: text,
    step_name: text,
    queue: text,
    task_id: text,
    event_name: text,
    status: text,
    timeout_at_ms: nullableInteger,
    created_at_ms: integer,
    fence_stamp: nullableText,
    fence_at_ms: nullableInteger,
  },
  events: {
    queue: text,
    event_name: text,
    payload: nullableText,
    emitted_at_ms: nullableInteger,
    fence_stamp: nullableText,
    fence_at_ms: nullableInteger,
  },
  // No provenance columns: a checkpoint is written only by a follow-on, which takes its
  // instant from the run the batch stamped.
  checkpoints: {
    task_id: text,
    checkpoint_name: text,
    queue: text,
    state: text,
    owner_run_id: text,
    owner_attempt: integer,
    updated_at_ms: integer,
  },
} as const satisfies Record<string, Record<string, ColumnSpec>>

/** Integer columns accept a number or a bigint, as the drivers bind them. */
type ColumnValue<Spec> = Spec extends ColumnSpec<infer Kind, infer Nullable>
  ? (Kind extends 'text' ? string : number | bigint) | (Nullable extends true ? null : never)
  : never

/** The builder's table types, derived from `STORE_TABLE_COLUMNS`. */
export type StoreTables = {
  -readonly [Table in keyof typeof STORE_TABLE_COLUMNS]: {
    -readonly [Column in keyof (typeof STORE_TABLE_COLUMNS)[Table]]: ColumnValue<
      (typeof STORE_TABLE_COLUMNS)[Table][Column]
    >
  }
}

/** The one builder every shared statement builds trees with. */
export const treeBuilder = compileOnlyBuilder<StoreTables>()

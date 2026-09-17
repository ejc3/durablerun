/**
 * Column types for the stores' statement builders. A builder rejects a column this
 * file does not name, so a misspelled column is a type error rather than SQL that
 * fails at run time. Integer columns accept a number or a bigint, as the drivers bind
 * them.
 */
type Integer = number | bigint

export interface RunsTable {
  run_id: string
  queue: string
  task_id: string
  attempt: Integer
  state: string
  claimed_by: string | null
  claim_gen: Integer
  activated_gen: Integer
  relaunch_count: Integer
  lease_ms: Integer | null
  claim_expires_at_ms: Integer | null
  heartbeat_at_ms: Integer | null
  available_at_ms: Integer | null
  wake_event: string | null
  wake_step: string | null
  event_payload: string | null
  run_db: string | null
  started_at_ms: Integer | null
  completed_at_ms: Integer | null
  failed_at_ms: Integer | null
  result: string | null
  created_at_ms: Integer
  fence_stamp: string | null
  fence_at_ms: Integer | null
}

export interface TasksTable {
  task_id: string
  queue: string
  task_name: string
  params: string
  headers: string | null
  retry_strategy: string
  max_attempts: Integer
  cancellation: string | null
  idempotency_key: string | null
  state: string
  attempts: Integer
  infra_retries: Integer
  last_attempt_run: string | null
  enqueue_at_ms: Integer
  first_started_at_ms: Integer | null
  cancel_at_ms: Integer | null
  cancelled_at_ms: Integer | null
  created_at_ms: Integer
  fence_stamp: string | null
  fence_at_ms: Integer | null
}

/**
 * The tables statement builders may name. Later PRs add waits, events, and checkpoints.
 * The task outcome columns stay out until a tree statement writes them, because the
 * outcome lint confines them to the stores and `decodeTaskResult`.
 */
export interface StoreTables {
  runs: RunsTable
  tasks: TasksTable
}

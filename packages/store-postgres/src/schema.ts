/**
 * PostgreSQL scheduler-plane schema.
 *
 * The logical shape and migration numbers track store-libsql, while the
 * physical representation follows the portable contract: identifiers and
 * JSON stay TEXT and every durable counter, duration, and epoch-millisecond
 * instant is BIGINT. PostgreSQL-specific event lock rows are internal
 * serialization sentinels, not protocol state.
 */

import { FENCED_TABLES } from '@durablerun/core'

export interface PostgresMigration {
  readonly version: number
  readonly statements: readonly string[]
}

/** The one read whose undefined-table SQLSTATE means the database is fresh. */
export const SCHEMA_VERSION_READ_SQL =
  `SELECT value FROM meta WHERE key = 'schema_version'` as const

// A migration must not rewrite a table that a read batch reads, or create one together
// with rows a reader requires. Read batches hold a REPEATABLE READ snapshot taken before
// they resolve names, and PostgreSQL shows a rewritten table (ALTER COLUMN TYPE, a
// volatile default, TRUNCATE) as empty to a snapshot older than the rewrite. Creating an
// empty table and adding a nullable column are safe. The meta table is the one created
// with a required row, which is why its version read is READ COMMITTED (executor.ts).
export const MIGRATIONS: readonly PostgresMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        task_name TEXT NOT NULL,
        params TEXT NOT NULL,
        headers TEXT,
        retry_strategy TEXT NOT NULL,
        max_attempts BIGINT NOT NULL,
        cancellation TEXT,
        idempotency_key TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','running','sleeping','completed','failed','cancelled')),
        attempts BIGINT NOT NULL DEFAULT 0,
        infra_retries BIGINT NOT NULL DEFAULT 0,
        last_attempt_run TEXT,
        completed_payload TEXT,
        failure_reason TEXT,
        enqueue_at_ms BIGINT NOT NULL,
        first_started_at_ms BIGINT,
        cancel_at_ms BIGINT,
        cancelled_at_ms BIGINT,
        created_at_ms BIGINT NOT NULL
      )`,

      `CREATE UNIQUE INDEX tasks_idem
        ON tasks (queue, idempotency_key) WHERE idempotency_key IS NOT NULL`,

      `CREATE INDEX tasks_cancel
        ON tasks (queue, cancel_at_ms)
        WHERE cancel_at_ms IS NOT NULL
          AND state IN ('pending','running','sleeping')`,

      `CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt BIGINT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('pending','running','sleeping','completed','failed','cancelled')),
        claimed_by TEXT,
        claim_gen BIGINT NOT NULL DEFAULT 0,
        activated_gen BIGINT NOT NULL DEFAULT 0,
        relaunch_count BIGINT NOT NULL DEFAULT 0,
        lease_ms BIGINT,
        claim_expires_at_ms BIGINT,
        heartbeat_at_ms BIGINT,
        available_at_ms BIGINT,
        wake_event TEXT,
        event_payload TEXT,
        run_db TEXT,
        started_at_ms BIGINT,
        completed_at_ms BIGINT,
        failed_at_ms BIGINT,
        result TEXT,
        failure_reason TEXT,
        created_at_ms BIGINT NOT NULL
      )`,

      `CREATE INDEX runs_poll
        ON runs (queue, state, available_at_ms)`,

      `CREATE INDEX runs_lease
        ON runs (queue, claim_expires_at_ms)
        WHERE state = 'running' AND claim_expires_at_ms IS NOT NULL`,

      `CREATE UNIQUE INDEX runs_task_attempt
        ON runs (task_id, attempt)`,

      `CREATE TABLE checkpoints (
        task_id TEXT NOT NULL,
        checkpoint_name TEXT NOT NULL,
        queue TEXT NOT NULL,
        state TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'committed',
        owner_run_id TEXT NOT NULL,
        owner_attempt BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (task_id, checkpoint_name)
      )`,

      `CREATE TABLE events (
        queue TEXT NOT NULL,
        event_name TEXT NOT NULL,
        payload TEXT,
        emitted_at_ms BIGINT,
        PRIMARY KEY (queue, event_name)
      )`,

      `CREATE TABLE waits (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        queue TEXT NOT NULL,
        task_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting'
          CHECK (status IN ('waiting','delivered')),
        timeout_at_ms BIGINT,
        created_at_ms BIGINT NOT NULL,
        PRIMARY KEY (run_id, step_name)
      )`,

      `CREATE INDEX waits_event ON waits (queue, event_name)`,

      // awaitEvent and emitEvent both lock this row before touching protocol
      // state. Keeping the sentinel distinct from events means "not emitted"
      // still has a row that PostgreSQL can lock.
      `CREATE TABLE event_locks (
        queue TEXT NOT NULL,
        event_name TEXT NOT NULL,
        PRIMARY KEY (queue, event_name)
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE drivers (
        queue TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        last_beat_ms BIGINT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        PRIMARY KEY (queue, driver_id)
      )`,
    ],
  },
  {
    version: 3,
    statements: [`ALTER TABLE runs ADD COLUMN wake_step TEXT`],
  },
  {
    version: 4,
    statements: FENCED_TABLES.flatMap((table) => [
      `ALTER TABLE ${table} ADD COLUMN fence_stamp TEXT`,
      `ALTER TABLE ${table} ADD COLUMN fence_at_ms BIGINT`,
    ]),
  },
  {
    // v5 is SQLite's driver-heartbeat trigger realization. PostgreSQL keeps
    // the same logical schema version while its store performs the atomic
    // upsert-and-cleanup with one writable CTE, so no DDL is needed here.
    version: 5,
    statements: [],
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

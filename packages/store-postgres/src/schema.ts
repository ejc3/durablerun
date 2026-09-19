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
      // still has a row that PostgreSQL can lock. A task's completion event,
      // which the engine alone writes, is locked without a row (executor.ts).
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
  {
    // A batch that ends a task or emits an event finds the runs it just woke by their
    // `wake_event`, among the pending runs of the queue. This index holds only runs
    // that were woken and are not yet claimed, so that lookup reads those rows and not
    // the queue's whole pending backlog. It is an index and nothing else: a build that
    // predates it runs against this schema unchanged.
    version: 6,
    statements: [
      `CREATE INDEX runs_woken ON runs (queue, wake_event)
       WHERE wake_event IS NOT NULL AND state = 'pending'`,
    ],
  },
  {
    // A text column takes the collation of its database unless it declares one, and a
    // database's collation is its operator's or its host's choice. Under a linguistic one
    // `getCheckpoints` returned a caller's names in an order no other dialect returns,
    // the task result's tie between two names broke another way, and a range over a name
    // would miss its rows. SQLite compares bytes and the MySQL schema declares a binary
    // collation on every string column, so every text column here declares "C", which
    // compares bytes. The stored bytes do not change, so no table is rewritten, which the
    // rule above forbids: PostgreSQL rebuilds each index that holds a changed column and
    // nothing else, and the collation test holds both. The first statement takes every
    // lock the rest need before any index is built. Without it the version takes each
    // table's lock only after it has rebuilt the tables before it, and a live transaction
    // that holds a later table while it waits for an earlier one deadlocks with a
    // migration that has indexes built. Once a table's rebuild outlasts the deadlock
    // timeout, the migration is the transaction PostgreSQL aborts, and it lost every
    // attempt that way. With the locks first it can only be aborted before it has built
    // anything, and the executor runs it again.
    version: 7,
    statements: [
      `LOCK TABLE meta, tasks, runs, checkpoints, events, waits, event_locks, drivers
        IN ACCESS EXCLUSIVE MODE`,
      `ALTER TABLE meta
        ALTER COLUMN key TYPE TEXT COLLATE "C",
        ALTER COLUMN value TYPE TEXT COLLATE "C"`,
      `ALTER TABLE tasks
        ALTER COLUMN task_id TYPE TEXT COLLATE "C",
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN task_name TYPE TEXT COLLATE "C",
        ALTER COLUMN params TYPE TEXT COLLATE "C",
        ALTER COLUMN headers TYPE TEXT COLLATE "C",
        ALTER COLUMN retry_strategy TYPE TEXT COLLATE "C",
        ALTER COLUMN cancellation TYPE TEXT COLLATE "C",
        ALTER COLUMN idempotency_key TYPE TEXT COLLATE "C",
        ALTER COLUMN state TYPE TEXT COLLATE "C",
        ALTER COLUMN last_attempt_run TYPE TEXT COLLATE "C",
        ALTER COLUMN completed_payload TYPE TEXT COLLATE "C",
        ALTER COLUMN failure_reason TYPE TEXT COLLATE "C",
        ALTER COLUMN fence_stamp TYPE TEXT COLLATE "C"`,
      `ALTER TABLE runs
        ALTER COLUMN run_id TYPE TEXT COLLATE "C",
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN task_id TYPE TEXT COLLATE "C",
        ALTER COLUMN state TYPE TEXT COLLATE "C",
        ALTER COLUMN claimed_by TYPE TEXT COLLATE "C",
        ALTER COLUMN wake_event TYPE TEXT COLLATE "C",
        ALTER COLUMN event_payload TYPE TEXT COLLATE "C",
        ALTER COLUMN run_db TYPE TEXT COLLATE "C",
        ALTER COLUMN result TYPE TEXT COLLATE "C",
        ALTER COLUMN failure_reason TYPE TEXT COLLATE "C",
        ALTER COLUMN wake_step TYPE TEXT COLLATE "C",
        ALTER COLUMN fence_stamp TYPE TEXT COLLATE "C"`,
      `ALTER TABLE checkpoints
        ALTER COLUMN task_id TYPE TEXT COLLATE "C",
        ALTER COLUMN checkpoint_name TYPE TEXT COLLATE "C",
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN state TYPE TEXT COLLATE "C",
        ALTER COLUMN status TYPE TEXT COLLATE "C",
        ALTER COLUMN owner_run_id TYPE TEXT COLLATE "C"`,
      `ALTER TABLE events
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN event_name TYPE TEXT COLLATE "C",
        ALTER COLUMN payload TYPE TEXT COLLATE "C",
        ALTER COLUMN fence_stamp TYPE TEXT COLLATE "C"`,
      `ALTER TABLE waits
        ALTER COLUMN run_id TYPE TEXT COLLATE "C",
        ALTER COLUMN step_name TYPE TEXT COLLATE "C",
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN task_id TYPE TEXT COLLATE "C",
        ALTER COLUMN event_name TYPE TEXT COLLATE "C",
        ALTER COLUMN status TYPE TEXT COLLATE "C",
        ALTER COLUMN fence_stamp TYPE TEXT COLLATE "C"`,
      `ALTER TABLE event_locks
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN event_name TYPE TEXT COLLATE "C"`,
      `ALTER TABLE drivers
        ALTER COLUMN queue TYPE TEXT COLLATE "C",
        ALTER COLUMN driver_id TYPE TEXT COLLATE "C"`,
    ],
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

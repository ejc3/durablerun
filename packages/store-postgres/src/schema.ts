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
//
// A version that does long work on more than one table takes every lock it needs in its
// first statement. `migrate()` runs a version as one transaction. A version that takes a
// table's lock only after its work on the tables before it deadlocks with a live
// transaction that holds the later table while it waits for an earlier one, and once that
// work outlasts the deadlock timeout the migration is the transaction PostgreSQL aborts,
// with its work done. With the locks first it can only be aborted before it has done
// anything, and the executor runs it again.
//
// It takes them in the order the engine's own statements do. A batch that locks an event
// takes `event_locks` before anything else. A worker's reads name `checkpoints` before
// `runs` and `runs` before `tasks`. Every statement that reads the clock takes its own
// table and then `meta`, so `meta` comes last. A statement that arrives while the version
// waits for older transactions then waits holding nothing, and a waiter that holds nothing
// cannot deadlock. No one order fits every statement: the sweep's scan and the task result
// read name `tasks` first, and a write batch of several statements can hold a table the
// list has passed. Those can still lose a deadlock to a version, or make it lose one.
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
    // lock, by the rule above and in its order. Measured under live traffic with four
    // million rows a table, this version without that statement lost all three of the
    // executor's attempts, every time. Measured on an empty schema under writes, reads and
    // event batches, the same statement with `meta` first lost all three in 11 of 80
    // migrations while the server counted 568 deadlocks. In this order it lost none of 80,
    // and the server counted 126.
    version: 7,
    statements: [
      `LOCK TABLE event_locks, events, waits, checkpoints, runs, tasks, drivers, meta
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
  // Version 8 gave MySQL an index of a run's statement stamp, which its keyed deletes read
  // their keys through. PostgreSQL's DELETE takes no lock on the rows its subquery reads.
  // This version holds nothing here, so the three dialects keep one numbering.
  { version: 8, statements: [] },
  {
    // A claim finds what ONE token holds three ways: its held guard asks whether the token
    // holds a run already, its two follow-ons find the runs the batch just took, and its
    // receipt read returns them. By queue and state alone the only index was `runs_poll`,
    // so each of those read every running run of the queue, on every tick, the idle ones
    // included: one claim measured 64 ms beside 100,000 running runs against 7 ms. This
    // index holds only running runs, by their token. PostgreSQL matches it to a statement
    // that binds the state only when it plans with the value, which it does for the
    // unnamed statements the executor sends. It is an index and nothing else: a build that
    // predates it runs against this schema unchanged. Like version 6, it is built under a
    // lock that blocks writes to `runs` while it builds.
    version: 9,
    statements: [
      `CREATE INDEX runs_held ON runs (queue, claimed_by)
       WHERE state = 'running'`,
    ],
  },
  {
    // An await that timed out answers with no payload, and an emitted event answers with
    // its payload, so an event row that held SQL NULL would read as a timeout. The port
    // refuses to write one. From this version the column refuses it too, for every writer
    // there is, a port in another language included.
    //
    // The statement takes an ACCESS EXCLUSIVE lock on `events` as its first act and then
    // reads every row once. It rewrites nothing, so a read batch's older snapshot sees the
    // table as it was. It is one statement on one table, which is the rule above in its
    // smallest form: the version never asks for a second store table, and a statement that
    // holds `events` needs only a read of `meta`, which the runner's lock on `meta` does not
    // block, so there is no cycle for a deadlock to close. Measured on a million events
    // under the traffic of a build whose last version is 9: 85 to 129 ms with 64 B payloads
    // and 390 ms with 1 KB, the longest call that overlapped it waited that long, and no call
    // failed.
    //
    // A row that holds NULL makes the statement fail with SQLSTATE 23502, the transaction
    // rolls back, and the database stays at version 9 with the row as it was. The rows are
    // found with `SELECT queue, event_name FROM events WHERE payload IS NULL`.
    version: 10,
    statements: ['ALTER TABLE events ALTER COLUMN payload SET NOT NULL'],
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

/**
 * The schema versions this build's reads accept. A read-only tool, such as the operator
 * CLI, answers against any version in the window and refuses one outside it, and it never
 * migrates. This store was never released, so no deployed database is known to be at an
 * older version, and the window is the current version alone. A database recorded past
 * `newest` was migrated by a newer build and is refused.
 */
export const READABLE_SCHEMA_WINDOW = Object.freeze({
  oldest: CURRENT_SCHEMA_VERSION,
  newest: CURRENT_SCHEMA_VERSION,
})

/**
 * What an operator should know before a migration crosses a version, keyed by that
 * version, for a tool that migrates, such as the operator CLI, to print first. A database
 * that was never initialized holds no rows, and a tool may leave the notes out for it.
 */
export const SCHEMA_VERSION_NOTES: Readonly<Record<number, string>> = Object.freeze({
  10: 'version 10 takes a lock on events that blocks every other call on the table, reads included, and reads every stored event under it; on a million events it held the lock for 85 to 390 ms. It first waits behind every open transaction that has touched events, and nothing bounds that wait, so run it when none is open. A stored event whose payload is NULL makes it fail and leaves version 9: find such rows first with SELECT queue, event_name FROM events WHERE payload IS NULL.',
})

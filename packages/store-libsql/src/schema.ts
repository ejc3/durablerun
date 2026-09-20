/**
 * Scheduler-plane schema (DESIGN.md §3.4): Absurd's five tables collapsed to
 * a shared-`queue`-column design, JSON as TEXT, INTEGER epoch-milliseconds.
 * `runs.run_db` is reserved for Phase 6 dedicated placement.
 *
 * Migrations are versioned DDL lists. The runner (admin.ts) wraps each in one
 * atomic batch with a STRUCTURAL fence — an `applied:vN` sentinel INSERT
 * whose primary-key violation rolls the whole batch back on a concurrent or
 * stale re-apply — plus the version bump. Authors write plain DDL; the fence
 * cannot be forgotten (prevention, per the standing rule, for the
 * read-then-apply migration race).
 *
 * The `meta` table is created by the runner itself before any migration.
 */

import { FENCED_TABLES, MAX_EPOCH_MS } from '@durablerun/core'

export interface Migration {
  version: number
  statements: string[]
}

/** The one read whose missing `meta` table means the database is fresh. */
export const SCHEMA_VERSION_READ_SQL =
  `SELECT value FROM meta WHERE key = 'schema_version'` as const

export const DRIVER_HEARTBEAT_INGRESS = 'driver_heartbeat_ingress'

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        task_name TEXT NOT NULL,
        params TEXT NOT NULL,
        headers TEXT,
        retry_strategy TEXT NOT NULL,
        max_attempts INTEGER NOT NULL,
        cancellation TEXT,
        idempotency_key TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','running','sleeping','completed','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        infra_retries INTEGER NOT NULL DEFAULT 0,
        last_attempt_run TEXT,
        completed_payload TEXT,
        failure_reason TEXT,
        enqueue_at_ms INTEGER NOT NULL,
        first_started_at_ms INTEGER,
        cancel_at_ms INTEGER,
        cancelled_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID`,

      `CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem
        ON tasks (queue, idempotency_key) WHERE idempotency_key IS NOT NULL`,

      `CREATE INDEX IF NOT EXISTS tasks_cancel
        ON tasks (queue, cancel_at_ms)
        WHERE cancel_at_ms IS NOT NULL
          AND state IN ('pending','running','sleeping')`,

      `CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('pending','running','sleeping','completed','failed','cancelled')),
        claimed_by TEXT,
        claim_gen INTEGER NOT NULL DEFAULT 0,
        activated_gen INTEGER NOT NULL DEFAULT 0,
        relaunch_count INTEGER NOT NULL DEFAULT 0,
        lease_ms INTEGER,
        claim_expires_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        available_at_ms INTEGER,
        wake_event TEXT,
        event_payload TEXT,
        run_db TEXT,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        failed_at_ms INTEGER,
        result TEXT,
        failure_reason TEXT,
        created_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID`,

      `CREATE INDEX IF NOT EXISTS runs_poll
        ON runs (queue, state, available_at_ms)`,

      `CREATE INDEX IF NOT EXISTS runs_lease
        ON runs (queue, claim_expires_at_ms)
        WHERE state = 'running' AND claim_expires_at_ms IS NOT NULL`,

      `CREATE UNIQUE INDEX IF NOT EXISTS runs_task_attempt
        ON runs (task_id, attempt)`,

      `CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT NOT NULL,
        checkpoint_name TEXT NOT NULL,
        queue TEXT NOT NULL,
        state TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'committed',
        owner_run_id TEXT NOT NULL,
        owner_attempt INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (task_id, checkpoint_name)
      ) WITHOUT ROWID`,

      `CREATE TABLE IF NOT EXISTS events (
        queue TEXT NOT NULL,
        event_name TEXT NOT NULL,
        payload TEXT,
        emitted_at_ms INTEGER,
        PRIMARY KEY (queue, event_name)
      ) WITHOUT ROWID`,

      `CREATE TABLE IF NOT EXISTS waits (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        queue TEXT NOT NULL,
        task_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting'
          CHECK (status IN ('waiting','delivered')),
        timeout_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_name)
      ) WITHOUT ROWID`,

      `CREATE INDEX IF NOT EXISTS waits_event ON waits (queue, event_name)`,
    ],
  },
  {
    // Migrations are APPEND-ONLY: the runner skips versions a database has
    // already applied, so editing a shipped migration silently strands every
    // existing database without the change (schema.test.ts pins v1 frozen).
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS drivers (
        queue TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        last_beat_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (queue, driver_id)
      ) WITHOUT ROWID`,
    ],
  },
  {
    // wake_step binds a delivered event/timeout wake to the exact await
    // that registered it (its step key), so a run awaiting one event name
    // at two call sites cannot have one await's wake consumed by another.
    // Travels with wake_event/event_payload through every transition.
    version: 3,
    statements: [`ALTER TABLE runs ADD COLUMN wake_step TEXT`],
  },
  {
    // Write provenance (DESIGN.md §3.4 rule 8). A batch's compare-and-set
    // stamps every row it transitions with `<batch seed>:<statement name>`
    // and records the ONE instant that batch read; every later statement in
    // the batch filters on that stamp and derives every instant it needs from
    // fence_at_ms, never from a second clock read.
    //
    // Before this, a batch had no column of its own to write provenance into,
    // so each transition borrowed a column that already meant something else —
    // runs.claimed_by (the lease), tasks.failure_reason (a user-visible JSON
    // string). Borrowing is why the two recurring bug classes kept recurring:
    // a borrowed column can be written by something OTHER than this batch, so
    // a follow-on keyed on it fires for a stale or duplicated caller.
    //
    // Nullable, no default, no index. Rows written before v4 read NULL, and
    // NULL never equals a stamp, so no fence can match a pre-v4 row. A stamp
    // is a FILTER, never a lookup key — every fenced statement is anchored by
    // a primary key or an existing index, so no index is needed and adding one
    // would cost a write on every transition.
    //
    // checkpoints, drivers and meta deliberately get no columns: nothing
    // compare-and-sets them. That exemption is not a maintained list — the
    // audit derives its table set from the schema, and batch-lint requires any
    // table named as a CAS target to declare fence_stamp here.
    // The table list is the CONTRACT's (core's FENCED_TABLES), not this
    // dialect's: the same four tables carry provenance in every dialect, and
    // each dialect writes its own DDL for them. Because the frozen-hash test
    // hashes these statements, widening the contract list changes v4's hash
    // and fails the build until a v5 migration is appended — which is the
    // correct outcome, since v4 has already shipped.
    version: 4,
    statements: FENCED_TABLES.flatMap((table) => [
      `ALTER TABLE ${table} ADD COLUMN fence_stamp TEXT`,
      `ALTER TABLE ${table} ADD COLUMN fence_at_ms INTEGER`,
    ]),
  },
  {
    // SQLite cannot put an INSERT/UPDATE inside a CTE. Triggers keep driver
    // cleanup in one atomic statement. An INSTEAD OF trigger on a dedicated
    // write-only ingress is important: setup/repair writes to the durable
    // table do not accidentally perform cleanup, while a heartbeat that
    // passes its epoch-headroom guard necessarily runs both the upsert and
    // cleanup from the same NEW.last_beat_ms value.
    version: 5,
    statements: [
      `CREATE VIEW ${DRIVER_HEARTBEAT_INGRESS} AS
       SELECT queue, driver_id, last_beat_ms, expires_at_ms FROM drivers`,
      `CREATE TRIGGER driver_heartbeat_apply
       INSTEAD OF INSERT ON ${DRIVER_HEARTBEAT_INGRESS}
       BEGIN
         INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
         VALUES (NEW.queue, NEW.driver_id, NEW.last_beat_ms, NEW.expires_at_ms)
         ON CONFLICT (queue, driver_id) DO UPDATE SET
           last_beat_ms = excluded.last_beat_ms,
           expires_at_ms = excluded.expires_at_ms;
         DELETE FROM drivers
         WHERE expires_at_ms < NEW.last_beat_ms
           AND typeof(last_beat_ms) = 'integer'
           AND last_beat_ms BETWEEN 0 AND ${MAX_EPOCH_MS}
           AND typeof(expires_at_ms) = 'integer'
           AND expires_at_ms BETWEEN 0 AND ${MAX_EPOCH_MS};
       END`,
    ],
  },
  {
    // A batch that ends a task or emits an event finds the runs it just woke by their
    // `wake_event`, among the pending runs of the queue. This index holds only runs
    // that were woken and are not yet claimed, so that lookup reads those rows and not
    // the queue's whole pending backlog. It is an index and nothing else: a build that
    // predates it runs against this schema unchanged.
    version: 6,
    statements: [
      `CREATE INDEX IF NOT EXISTS runs_woken ON runs (queue, wake_event)
       WHERE wake_event IS NOT NULL AND state = 'pending'`,
    ],
  },
  {
    // PostgreSQL's version 7 declares a byte collation on every text column. SQLite
    // compares text by its bytes unless a column says otherwise, and none here does, so
    // this version holds nothing and keeps the numbering of the dialects aligned.
    version: 7,
    statements: [],
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

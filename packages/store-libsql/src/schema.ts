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

export interface Migration {
  version: number
  statements: string[]
}

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

      `CREATE TABLE IF NOT EXISTS drivers (
        driver_id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        last_beat_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
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
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

import type { SqlExecutor } from '@durablerun/core'

/**
 * The TLA+ invariants as executable SQL checkers (prevention, per the
 * standing rule: scenario tests assert what their author predicted; these
 * assert what the MODEL guarantees, so any scenario or fuzz schedule that
 * reaches a corrupt state fails regardless of what the author expected).
 * Run after every sim quiescence and any time a scenario finishes.
 */
export async function engineInvariantViolations(raw: SqlExecutor): Promise<string[]> {
  const checks: { name: string; sql: string }[] = [
    {
      // TerminalTaskQuiescent: a terminal task has no live runs.
      name: 'terminal-task-with-live-run',
      sql: `SELECT t.task_id || '/' || r.run_id AS v
            FROM tasks t JOIN runs r ON r.task_id = t.task_id
            WHERE t.state IN ('failed','cancelled','completed')
              AND r.state IN ('pending','running','sleeping')`,
    },
    {
      // LeaseAuthority: every running run has an owner.
      name: 'ownerless-running-run',
      sql: `SELECT run_id AS v FROM runs WHERE state = 'running' AND claimed_by IS NULL`,
    },
    {
      // State mirror: a running run implies a running task.
      name: 'running-run-under-non-running-task',
      sql: `SELECT r.run_id AS v
            FROM runs r JOIN tasks t ON t.task_id = r.task_id
            WHERE r.state = 'running' AND t.state <> 'running'`,
    },
    {
      // State mirror, other direction: a running task has some live run.
      name: 'running-task-with-no-live-run',
      sql: `SELECT t.task_id AS v FROM tasks t
            WHERE t.state = 'running' AND NOT EXISTS (
              SELECT 1 FROM runs r WHERE r.task_id = t.task_id
                AND r.state IN ('pending','running','sleeping')
            )`,
    },
    {
      // SingleActiveRunPerTask.
      name: 'multiple-live-runs-per-task',
      sql: `SELECT task_id AS v FROM runs
            WHERE state IN ('pending','running','sleeping')
            GROUP BY task_id HAVING COUNT(*) > 1`,
    },
    {
      // The TLA FailRunWithRetry guard's executable twin: user attempts can
      // never exceed the cap (this exact absence let fail() retry past
      // max_attempts while the fuzz ran green).
      name: 'attempts-exceeds-cap',
      sql: `SELECT task_id AS v FROM tasks WHERE attempts > max_attempts`,
    },
    {
      // Checkpoint referential integrity: a checkpoint's owner run must
      // belong to the checkpoint's task and queue (fence-scope class: args
      // bound into a fence narrower than the argument surface).
      name: 'checkpoint-cross-task',
      sql: `SELECT c.task_id || '/' || c.checkpoint_name AS v
            FROM checkpoints c JOIN runs r ON r.run_id = c.owner_run_id
            WHERE r.task_id <> c.task_id OR r.queue <> c.queue`,
    },
    {
      // Waits must reference live runs (orphans pin event GC).
      name: 'wait-referencing-dead-run',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN runs r ON r.run_id = w.run_id
            WHERE r.state NOT IN ('pending','running','sleeping')`,
    },
    {
      // Every LIVE task has EXACTLY ONE live run (generalizes the running-
      // only checks above to pending/sleeping — the foreign-successor
      // corruption left a pending task with zero runs of its own and no
      // checker noticed).
      name: 'live-task-without-exactly-one-live-run',
      sql: `SELECT t.task_id AS v FROM tasks t
            WHERE t.state IN ('pending','running','sleeping')
              AND (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.task_id
                     AND r.state IN ('pending','running','sleeping')) <> 1`,
    },
    {
      // Exact state mirror: a live task's live run carries the SAME state.
      name: 'task-run-state-mismatch',
      sql: `SELECT t.task_id || '/' || r.run_id AS v
            FROM tasks t JOIN runs r ON r.task_id = t.task_id
            WHERE t.state IN ('pending','running','sleeping')
              AND r.state IN ('pending','running','sleeping')
              AND r.state <> t.state`,
    },
    {
      // Orphan checks must be LEFT JOINs — an inner join makes a MISSING
      // owner row invisible to the checker (codex finding).
      name: 'checkpoint-owner-run-missing',
      sql: `SELECT c.task_id || '/' || c.checkpoint_name AS v
            FROM checkpoints c LEFT JOIN runs r ON r.run_id = c.owner_run_id
            WHERE r.run_id IS NULL`,
    },
    {
      name: 'wait-run-missing',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w LEFT JOIN runs r ON r.run_id = w.run_id
            WHERE r.run_id IS NULL`,
    },
    {
      // TypeOK twin, storage-class arm: INTEGER columns are affinity, not
      // enforcement — a REAL or text epoch is corruption regardless of path
      // (§3.4 rule 7 is the prevention; this is the detection).
      name: 'temporal-storage-class',
      sql: `SELECT 'runs/' || run_id AS v FROM runs
            WHERE typeof(available_at_ms) NOT IN ('integer','null')
               OR typeof(claim_expires_at_ms) NOT IN ('integer','null')
               OR typeof(heartbeat_at_ms) NOT IN ('integer','null')
               OR typeof(created_at_ms) NOT IN ('integer','null')
               OR typeof(lease_ms) NOT IN ('integer','null')
            UNION ALL
            SELECT 'tasks/' || task_id FROM tasks
            WHERE typeof(enqueue_at_ms) NOT IN ('integer','null')
               OR typeof(cancel_at_ms) NOT IN ('integer','null')
            UNION ALL
            SELECT 'checkpoints/' || task_id || '/' || checkpoint_name FROM checkpoints
            WHERE typeof(updated_at_ms) NOT IN ('integer','null')`,
    },
    {
      // TypeOK twin, generation/counter arm.
      name: 'generation-or-counter-corrupt',
      sql: `SELECT run_id AS v FROM runs
            WHERE activated_gen > claim_gen OR claim_gen < 0 OR relaunch_count < 0
            UNION ALL
            SELECT task_id FROM tasks WHERE attempts < 0 OR infra_retries < 0`,
    },
  ]
  const results = await raw.batch(
    'invariants',
    checks.map((c) => ({ sql: c.sql, args: [] })),
    'read',
  )
  const violations: string[] = []
  checks.forEach((check, i) => {
    for (const row of results[i]?.rows ?? []) {
      violations.push(`${check.name}: ${String(row.v)}`)
    }
  })
  return violations
}

export async function assertEngineInvariants(raw: SqlExecutor): Promise<void> {
  const violations = await engineInvariantViolations(raw)
  if (violations.length > 0) {
    throw new Error(`engine invariant violations:\n  ${violations.join('\n  ')}`)
  }
}

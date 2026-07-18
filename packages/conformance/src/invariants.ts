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
      // Waits must reference live runs (orphans pin event GC).
      name: 'wait-referencing-dead-run',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN runs r ON r.run_id = w.run_id
            WHERE r.state NOT IN ('pending','running','sleeping')`,
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

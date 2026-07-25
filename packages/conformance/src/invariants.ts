import type { SqlExecutor, SqlRow } from '@durablerun/core'

type Check =
  | { name: string; sql: string; evaluate?: never }
  | {
      name?: never
      sql: string
      evaluate(rows: readonly SqlRow[]): string[]
    }

const PROVENANCE_EVIDENCE = `
  SELECT 'tasks' AS source, task_id AS key1, NULL AS key2,
         fence_stamp, fence_at_ms FROM tasks
  UNION ALL
  SELECT 'runs', run_id, NULL, fence_stamp, fence_at_ms FROM runs
  UNION ALL
  SELECT 'waits', run_id, step_name, fence_stamp, fence_at_ms FROM waits
  UNION ALL
  SELECT 'events', queue, event_name, fence_stamp, fence_at_ms FROM events`

function provenanceViolations(rows: readonly SqlRow[]): string[] {
  const violations: string[] = []
  const instantsBySeed = new Map<string, Set<string>>()

  for (const row of rows) {
    const location = [row.source, row.key1, row.key2]
      .filter((part) => part !== null && part !== undefined)
      .map(String)
      .join('/')
    const stamp = row.fence_stamp
    const instant = row.fence_at_ms
    const hasStamp = stamp !== null && stamp !== undefined
    const hasInstant = instant !== null && instant !== undefined
    const separator = typeof stamp === 'string' ? stamp.lastIndexOf(':') : -1
    const malformedStamp =
      hasStamp && (typeof stamp !== 'string' || separator <= 0 || separator === stamp.length - 1)

    /**
     * The provenance pair is written together or not at all, and always in
     * the shape the primitive generates. This data-level audit sees every row
     * regardless of whether its writer went through FencedBatch.
     */
    if (hasStamp !== hasInstant || malformedStamp) {
      violations.push(`provenance-pair-broken: ${location}`)
      continue
    }
    if (!hasStamp || !hasInstant || typeof stamp !== 'string') continue

    /**
     * Rule 8, as surviving data: rows sharing one opaque seed must carry one
     * instant. The statement name is the final colon-delimited segment; the
     * seed itself may contain colons.
     */
    const seed = stamp.slice(0, separator)
    const instants = instantsBySeed.get(seed) ?? new Set<string>()
    instants.add(String(instant))
    instantsBySeed.set(seed, instants)
  }

  for (const [seed, instants] of instantsBySeed) {
    if (instants.size < 2) continue
    const ordered = [...instants].sort(
      (left, right) => Number(left) - Number(right) || left.localeCompare(right),
    )
    violations.push(`one-batch-two-instants: ${seed} saw ${ordered[0]} and ${ordered.at(-1)}`)
  }
  return violations
}

/**
 * The TLA+ invariants as executable SQL checkers (prevention, per the
 * standing rule: scenario tests assert what their author predicted; these
 * assert what the MODEL guarantees, so any scenario or fuzz schedule that
 * reaches a corrupt state fails regardless of what the author expected).
 * Run after every sim quiescence and any time a scenario finishes.
 */
export async function engineInvariantViolations(raw: SqlExecutor): Promise<string[]> {
  const checks: Check[] = [
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
      // The accounting identity the engine's counters are DERIVED from, and
      // therefore the thing that must not drift. A run's `attempt` is the
      // ordinal that counts every successor; `attempts` counts the ones a
      // user failure caused and `infra_retries` the ones infrastructure
      // caused, so together they equal the top ordinal minus one while a
      // successor is waiting, and exactly the top ordinal once a failure went
      // terminal and consumed the last run without replacing it. Anything
      // outside that band means a counter was written from something other
      // than the run it belongs to — which is precisely how a blind
      // increment, a double-applied batch, or a mismatched subquery shows up.
      name: 'attempt-accounting-drift',
      sql: `SELECT t.task_id AS v
            FROM tasks t
            JOIN (SELECT task_id, MAX(attempt) AS top FROM runs GROUP BY task_id) r
              ON r.task_id = t.task_id
            WHERE t.attempts + t.infra_retries > r.top
               OR t.attempts + t.infra_retries < r.top - 1`,
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
      // Wait referential integrity: a wait's run must belong to the wait's
      // task and queue (same fence-scope class as checkpoint-cross-task —
      // the waits table shipped without inheriting this check and the
      // unbound-task_id fence gap had no detection twin).
      name: 'wait-cross-task',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN runs r ON r.run_id = w.run_id
            WHERE r.task_id <> w.task_id OR r.queue <> w.queue`,
    },
    {
      // WaitIntegrity's executable twin: no waiter may still be 'waiting'
      // on an event that has fired — emit deletes satisfied waits in the
      // same batch, and registration is guarded on the event not existing,
      // so a surviving pair IS a lost wakeup.
      //
      // It became reachable when emit stopped deleting the registrations of
      // runs it declined to wake. Before that the only state this could name
      // was erased by the same batch that created it, so the check was true
      // by construction rather than by the engine being correct — and the
      // lost wakeup it describes happened silently. A row surviving here is
      // now the alarm for exactly that, and it is repairable while it exists.
      name: 'wait-for-fired-event',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN events e
              ON e.queue = w.queue AND e.event_name = w.event_name
            WHERE w.status = 'waiting'`,
    },
    {
      // WaitIntegrity: a waiting wait implies its run is PARKED (sleeping).
      // An orphan wait on a running run — the INSERT/park guard asymmetry —
      // must be visible, not invariant-clean.
      name: 'wait-on-non-sleeping-run',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN runs r ON r.run_id = w.run_id
            WHERE w.status = 'waiting' AND r.state <> 'sleeping'`,
    },
    {
      // WaitIntegrity: a run parked on a wait carries that wait's event as
      // its wake_event; a disagreement means the park and the wait row
      // registered different events (IS NOT is NULL-safe: a NULL wake_event
      // under a waiting wait is itself a violation).
      name: 'wait-wake-name-mismatch',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN runs r ON r.run_id = w.run_id
            WHERE w.status = 'waiting' AND r.wake_event IS NOT w.event_name`,
    },
    {
      // WaitIntegrity: a timed wait's deadline IS the run's wake time — they
      // are one value, so nextWakeAt never schedules the timeout after its
      // registered deadline (IS NOT is NULL-safe: an untimed wait has both
      // NULL and is clean).
      name: 'wait-timeout-availability-mismatch',
      sql: `SELECT w.run_id || '/' || w.step_name AS v
            FROM waits w JOIN runs r ON r.run_id = w.run_id
            WHERE w.status = 'waiting' AND w.timeout_at_ms IS NOT r.available_at_ms`,
    },
    {
      // PayloadMatchesEvent's executable twin: a delivered wake payload
      // must be the stored event's payload (a NULL event_payload is the
      // timeout marker and carries no obligation). LEFT JOIN so a payload
      // from a nonexistent event is corruption; IS NOT is NULL-safe so a
      // NULL stored payload cannot silently escape the comparison.
      name: 'wake-payload-mismatch',
      sql: `SELECT r.run_id AS v
            FROM runs r LEFT JOIN events e
              ON e.queue = r.queue AND e.event_name = r.wake_event
            WHERE r.event_payload IS NOT NULL
              AND (e.event_name IS NULL OR r.event_payload IS NOT e.payload)`,
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
      /**
       * One dialect-neutral evidence projection feeds both provenance
       * properties. Parsing and grouping live in TypeScript so the contract
       * does not depend on SQLite's instr/substr functions or concatenation
       * coercions. This remains a cross-instant consistency alarm rather than
       * an issuance ledger: same-instant reuse and overwritten evidence need
       * the source-level unique-token mechanism.
       */
      sql: PROVENANCE_EVIDENCE,
      evaluate: provenanceViolations,
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
    const rows = results[i]?.rows ?? []
    if (check.evaluate) {
      violations.push(...check.evaluate(rows))
    } else {
      for (const row of rows) violations.push(`${check.name}: ${String(row.v)}`)
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

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
      // TypeOK twin, generation/counter arm.
      /**
       * Rule 8, as data: every row a single batch stamped carries the SAME
       * instant. A batch reads the clock once, in its compare-and-set, and
       * every later statement derives from the `fence_at_ms` that recorded.
       * Two rows sharing a seed and disagreeing about when it happened means
       * some statement read the clock a second time.
       *
       * This is the executable twin of a rule that was previously enforced
       * only by looking for a token in SQL text — a check four different
       * spellings walked past, and which cannot see a raw clock read at all.
       * Here the evidence is in the database, so it holds for any path,
       * including ones that never touch the primitive.
       */
      /**
       * The provenance pair is written together or not at all, and always in
       * the shape the primitive generates. A stamp without an instant means
       * some statement wrote half the pair — a fresh claim of authorship
       * beside a stale or absent record of when — and a malformed stamp means
       * a row was written by something that is not the primitive at all.
       *
       * This is the data-level half of the audit: a construction check can
       * only see code that goes through `FencedBatch`, and this sees every
       * row however it got there.
       */
      name: 'provenance-pair-broken',
      sql: `WITH stamped AS (
              SELECT 'tasks'  AS t, task_id  AS id, fence_stamp AS s, fence_at_ms AS at FROM tasks
              UNION ALL SELECT 'runs',   run_id,  fence_stamp, fence_at_ms FROM runs
              UNION ALL SELECT 'waits',  run_id,  fence_stamp, fence_at_ms FROM waits
              UNION ALL SELECT 'events', event_name, fence_stamp, fence_at_ms FROM events
            )
            SELECT t || '/' || id AS v FROM stamped
            WHERE (s IS NOT NULL AND at IS NULL)
               OR (s IS NULL AND at IS NOT NULL)
               OR (s IS NOT NULL AND instr(s, ':') <= 1)
               OR (s IS NOT NULL AND length(s) - instr(s, ':') < 1)`,
    },
    {
      name: 'one-batch-two-instants',
      sql: `WITH stamped AS (
              SELECT fence_stamp AS s, fence_at_ms AS at FROM tasks  WHERE fence_stamp IS NOT NULL
              UNION ALL
              SELECT fence_stamp, fence_at_ms      FROM runs   WHERE fence_stamp IS NOT NULL
              UNION ALL
              SELECT fence_stamp, fence_at_ms      FROM waits  WHERE fence_stamp IS NOT NULL
              UNION ALL
              SELECT fence_stamp, fence_at_ms      FROM events WHERE fence_stamp IS NOT NULL
            ),
            seeded AS (
              SELECT substr(s, 1, instr(s, ':') - 1) AS seed, at FROM stamped
              WHERE instr(s, ':') > 0
            )
            SELECT seed || ' saw ' || MIN(at) || ' and ' || MAX(at) AS v
            FROM seeded GROUP BY seed HAVING MIN(at) <> MAX(at)`,
    },
    {
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

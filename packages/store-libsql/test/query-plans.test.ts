import type { SqlExecutor } from '@durablerun/core'
import { type Client, createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
  NEXT_WAKE_SQL,
  SWEEP_SCAN_CANCELS_SQL,
  SWEEP_SCAN_EXPIRED_SQL,
} from '../src/index.js'
import { testIdSource } from '../src/testing.js'

/**
 * Query-plan pinning (prevention suite, per the standing rule): the
 * adversarial review found hot queries silently degrading to full scans and
 * temp b-trees because indexes drifted from query shapes. These tests make
 * that class of regression a test failure: every hot path must hit its
 * intended index and never sort the backlog.
 */

let db: LibsqlExecutor
let raw: Client

async function plan(sql: string, args: (string | number)[] = []): Promise<string> {
  const [r] = await db.batch('plan', [{ sql: `EXPLAIN QUERY PLAN ${sql}`, args }], 'read')
  return (r?.rows ?? []).map((row) => String(row.detail)).join('\n')
}

/**
 * The plan for a WRITE, which needs a raw client: `EXPLAIN QUERY PLAN UPDATE`
 * through the executor's batch takes the writer lock and fails.
 *
 * That gap is why the suite pinned only reads, and it cost a real regression:
 * correlating emit's waiter subquery to `runs` — a correctness fix — silently
 * demoted it from the query's driver to a filter, turning a lookup over the
 * handful of waiters into a full scan of the runs table on every emit.
 * Nothing failed, because no write had a plan pinned.
 */
async function writePlan(sql: string, args: (string | number)[] = []): Promise<string> {
  const r = await raw.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args })
  return r.rows.map((row) => String(row.detail)).join('\n')
}

beforeEach(async () => {
  db = LibsqlExecutor.open(':memory:')
  await new LibsqlStoreAdmin(db).migrate()
  raw = createClient({ url: ':memory:' })
  await new LibsqlStoreAdmin(new LibsqlExecutor(raw)).migrate()
})

afterEach(() => {
  db.close()
  raw.close()
})

it('builds the write-plan schema through the production migration contract', async () => {
  const version = await raw.execute(
    `SELECT value FROM meta WHERE key IN ('schema_version', 'applied:v1') ORDER BY key`,
  )
  expect(version.rows.map((row) => String(row.value))).toEqual([
    '1',
    String(CURRENT_SCHEMA_VERSION),
  ])
})

describe('claim candidate legs', () => {
  async function shippedClaimStatements(): Promise<{ sql: string; args: unknown[] }[]> {
    const seen: { sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('claim-query-plan'))
    await store.claim('q', 'worker', { leaseSeconds: 60, limit: 10 })
    return seen
  }

  async function shippedClaimStatement(): Promise<{ sql: string; args: unknown[] }> {
    const seen = await shippedClaimStatements()
    const updates = seen.filter(
      (st) => /^\s*update "runs"/.test(st.sql) && st.sql.includes('"claim_gen" = "claim_gen" + ?'),
    )
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  // This deliberately recognizes the exact topology that escaped; it is not a
  // SQL parser. Nested SELECTs and keyword-looking string literals are known
  // false negatives, while the hosted dogfood run owns compatibility for the
  // selected claim path.
  function measuredUngroupedHavingClauses(sql: string): string[] {
    const upper = sql.toUpperCase()
    return [...upper.matchAll(/\bHAVING\b/g)]
      .filter((match) => {
        const before = upper.slice(0, match.index)
        return before.lastIndexOf('GROUP BY') < before.lastIndexOf('SELECT')
      })
      .map((match) => sql.slice(match.index, match.index + 40).replace(/\s+/g, ' '))
  }

  it('rejects the aggregate HAVING shape that remote Turso cannot parse', () => {
    expect(
      measuredUngroupedHavingClauses('SELECT COUNT(*) FROM t HAVING COUNT(*) = 1'),
    ).toHaveLength(1)
    expect(
      measuredUngroupedHavingClauses('SELECT key FROM t GROUP BY key HAVING COUNT(*) > 1'),
    ).toEqual([])
  })

  it('the shipped claim avoids the measured remote-Turso aggregate shape', async () => {
    const unsupported = (await shippedClaimStatements()).flatMap((st) =>
      measuredUngroupedHavingClauses(st.sql),
    )
    expect(unsupported, 'regression:remote-turso-claim-sql').toEqual([])
  })

  it('the shipped claim seeks eligible candidates before its per-leg limits', async () => {
    const st = await shippedClaimStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(p.match(/runs_poll/g)?.length).toBeGreaterThanOrEqual(2)
    expect(p).toContain('runs_task_attempt')
    expect(p).not.toContain('SCAN sibling')

    const siblingSource = 'FROM runs sibling'
    expect(st.sql.split(siblingSource)).toHaveLength(3)
    const degraded = st.sql.split(siblingSource).join(`${siblingSource} INDEXED BY runs_poll`)
    const degradedPlan = await writePlan(degraded, st.args as (string | number)[])
    expect(degradedPlan.match(/SCAN sibling/g)?.length ?? 0, degradedPlan).toBeGreaterThanOrEqual(2)
  })
})

describe('production sweep scans (exact shipped SQL)', () => {
  it('the cancel scan seeks tasks_cancel', async () => {
    const p = await plan(SWEEP_SCAN_CANCELS_SQL, ['q', 10])
    expect(p).toContain('tasks_cancel')
  })

  it('the expired-lease scan seeks runs_lease with no backlog sort', async () => {
    const p = await plan(SWEEP_SCAN_EXPIRED_SQL, ['q', 10])
    expect(p).toContain('runs_lease')
    expect(p).not.toContain('TEMP B-TREE')
  })
})

describe('lease queries', () => {
  it('the expired-lease sweep read seeks runs_lease', async () => {
    const p = await plan(
      `SELECT run_id FROM runs
       WHERE queue = ? AND state = 'running'
         AND claim_expires_at_ms IS NOT NULL AND claim_expires_at_ms <= ?`,
      ['q', 0],
    )
    expect(p).toContain('runs_lease')
  })

  it('per-queue MIN(claim_expires_at_ms) is an index seek, not a scan', async () => {
    const p = await plan(
      `SELECT MIN(claim_expires_at_ms) FROM runs
       WHERE queue = ? AND state = 'running' AND claim_expires_at_ms IS NOT NULL`,
      ['q'],
    )
    expect(p).toContain('runs_lease')
  })

  it('the PRODUCTION next-wake query seeks an index on every leg', async () => {
    // NEXT_WAKE_SQL was exported "so the query-plan suite pins it" and then
    // never imported: the pins above are hand-written stand-ins for its legs,
    // which is exactly the mistake this file's own header warns about — a pin
    // on a stand-in cannot catch drift in the query it protects. Every driver
    // tick runs this one, so a lost index term is a per-tick full scan.
    const p = await plan(NEXT_WAKE_SQL, ['q', 'q', 'q', 'q'])
    expect(p).not.toContain('SCAN runs')
    expect(p).not.toContain('SCAN tasks')
    expect(p).toContain('runs_poll')
    expect(p).toContain('runs_lease')
    expect(p).toContain('tasks_cancel')
  })
})

describe('the emit fan-out, which is a WRITE', () => {
  /**
   * Structurally the same statement emitEvent builds: the waits index picks
   * the waiters, and everything else filters them. The assertion is on the
   * DRIVER — `SEARCH runs USING PRIMARY KEY` means the waiters were looked up
   * and each run fetched by key; `SCAN runs` means every run in the table was
   * examined and the waits index reduced to a filter. Those differ by the size
   * of the runs table, which is unbounded in a durable-execution engine.
   */
  /**
   * The statement emitEvent ACTUALLY sends, recovered by running the real
   * operation through a recording executor.
   *
   * This pin used to EXPLAIN a hand-copied statement described as
   * "structurally the same" — a second representation of the shipped SQL,
   * which is the shape this repo has a standing rule against, and it drifted
   * exactly as that rule predicts: conditions added to the real statement
   * never reached the copy, and deleting the whole index driver from the
   * engine left this file green. A pin that can pass while the shipped
   * statement scans the runs table is not pinning anything.
   */
  async function shippedWakeStatement(): Promise<{ sql: string; args: unknown[] }> {
    const seen: { sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('query-plan'))
    await store.emitEvent('q', 'e', '{}')
    // Sealing consumes the delivery statement's intermediate fence with a
    // second runs UPDATE. Select the one statement that writes the payload,
    // and still require exactly one so the pin cannot silently choose among
    // competing delivery representations.
    const updates = seen.filter(
      (st) => /^\s*update "runs" set/.test(st.sql) && st.sql.includes('"event_payload" ='),
    )
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  it('is driven by the waits index, not by a scan of runs', async () => {
    const st = await shippedWakeStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(
      [
        p.includes('waits_event'),
        p.includes('SEARCH runs USING PRIMARY KEY'),
        !p.includes('SCAN runs'),
      ],
      'mutation-verdict:behavior:emit-index-driver',
    ).toEqual([true, true, true])
  })

  it('degrades to a full scan if the waiter subquery is correlated', async () => {
    // The shape that shipped briefly, kept as the counter-example so the
    // assertion above is known to be discriminating rather than vacuous.
    const p = await writePlan(
      `UPDATE runs SET state = 'pending', wake_event = ?
       WHERE state = 'sleeping' AND wake_event = ?
         AND run_id IN (SELECT w.run_id FROM waits w
                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting'
                          AND w.run_id = runs.run_id AND w.step_name = runs.wake_step)`,
      ['e', 'e', 'q', 'e'],
    )
    expect(p).toContain('SCAN runs')
  })
})

describe("a terminal batch's wake, which every task ending pays", () => {
  /**
   * Every batch that ends a task also wakes the runs parked on its completion event,
   * whether or not anyone awaits it. The follow-on that turns the woken runs' tasks
   * pending selects its source by queue and state. Correlated to `tasks` on the queue,
   * that source is evaluated once for every task row, so one `complete` costs the
   * queue's tasks times its pending runs. Measured on libSQL with nobody waiting: 21 ms
   * at 250 pending runs, 1,063 ms at 2,000, and 4 ms when the backlog sits in another
   * queue. The statement is recovered from the real operation, as the emit pin is.
   */
  async function shippedWakeTasksStatement(): Promise<{ sql: string; args: unknown[] }> {
    const seen: { sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        if (label === 'complete') {
          for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
        }
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('terminal-query-plan'))
    await store.spawn('q', 'job', '{}')
    const [run] = await store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claimed run')
    await store.activate('q', run.runId, 'worker', run.claimGen)
    await store.complete('q', run.runId, 'worker', '{}')
    // The batch updates tasks twice: once for the task it ends, and once for the tasks
    // of the runs it woke. Require exactly one of the second.
    const updates = seen.filter(
      (st) => /^\s*update "tasks" set/.test(st.sql) && st.sql.includes(`('pending')`),
    )
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  it('looks the woken tasks up by key, and never scans tasks once for each pending run', async () => {
    const st = await shippedWakeTasksStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(
      [
        p.includes('SEARCH tasks USING PRIMARY KEY'),
        !p.includes('SCAN tasks'),
        !p.includes('CORRELATED LIST SUBQUERY'),
      ],
      'mutation-verdict:behavior:wake-tasks-binds-the-queue',
    ).toEqual([true, true, true])
  })
  /**
   * The pin above reads the side of `wake-tasks` that is written. The side that is read
   * is where the cost was left: each of the three follow-ons that come after the wake
   * finds the runs this batch woke by queue and state, and the only index for that is
   * `runs_poll`, so every task ending walks every pending run of its queue. Measured on
   * libSQL with nobody waiting: 6 to 10 ms at 2,000 pending runs against 4 ms with the
   * backlog in another queue, and 215 ms at 100,000 against 55 ms. This reads every write
   * of every batch that ends a task through a call that needs no clock move.
   */
  async function shippedTerminalWrites(): Promise<
    { label: string; sql: string; args: unknown[] }[]
  > {
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        if (label === 'complete' || label === 'fail' || label === 'cancel-task') {
          for (const st of statements) seen.push({ label, sql: st.sql, args: [...st.args] })
        }
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('terminal-source-plans'))
    const ready = async (name: string) => {
      await store.spawn('q', name, '{}', { maxAttempts: 1 })
      const [run] = await store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected a claimed run')
      await store.activate('q', run.runId, 'worker', run.claimGen)
      return run
    }
    await store.complete('q', (await ready('completes')).runId, 'worker', '{}')
    await store.fail('q', (await ready('fails')).runId, 'worker', '{}', null)
    await store.cancelTask('q', (await store.spawn('q', 'is-cancelled', '{}')).taskId)
    expect([...new Set(seen.map((st) => st.label))]).toEqual(['complete', 'fail', 'cancel-task'])
    return seen.filter((st) => /^\s*(update|delete|insert)/i.test(st.sql))
  }

  it('finds the runs it woke without walking the pending runs of the queue', async () => {
    const walks: string[] = []
    for (const st of await shippedTerminalWrites()) {
      const p = await writePlan(st.sql, st.args as (string | number)[])
      for (const step of p.split('\n')) {
        if (/USING INDEX runs_poll \(queue=\? AND state=\?\)$/.test(step.trim())) {
          walks.push(`${st.label}: ${st.sql.trim().split(/\s+/).slice(0, 3).join(' ')}`)
        }
      }
    }
    expect(walks, 'mutation-verdict:behavior:wake-sources-find-the-woken-runs').toEqual([])
  })
})

describe('cancellation deadlines', () => {
  it('the cancellation sweep seeks tasks_cancel, never scanning tasks', async () => {
    const p = await plan(
      `SELECT task_id FROM tasks
       WHERE queue = ? AND cancel_at_ms IS NOT NULL AND cancel_at_ms <= ?
         AND state IN ('pending','running','sleeping')`,
      ['q', 0],
    )
    expect(p).toContain('tasks_cancel')
  })
})

describe('every write a store ships, by the table it writes', () => {
  /**
   * A generated follow-on writes the rows that belong to the rows its batch stamped: the
   * task of a run, the runs of a task. Left to correlate its source to the written table
   * on the queue, the source is a correlated subquery, SQLite cannot drive the write from
   * it, and the statement scans the table it writes and probes the source once for each
   * row. That is every task in the database, in any queue, on claim, activate, and
   * complete: one `complete` measured 61 ms beside 100,000 tasks. The statements are
   * recovered from the real operations, as the other pins of this file are, and every
   * UPDATE and DELETE of every label is planned, so a new follow-on is read too.
   */
  const REACHED = [
    'claim',
    'activate',
    'defer-launch',
    'reschedule',
    'suspend',
    'await-event',
    'emit-event',
    'complete',
    'fail',
    'retry-task',
    'cancel-task',
    'sweep:lost-launch',
    'sweep:claim-timeout',
  ]

  async function shippedWrites(): Promise<{ label: string; sql: string; args: unknown[] }[]> {
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ label, sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const admin = new LibsqlStoreAdmin(db)
    await admin.setFakeNowEpochMs(1_000_000)
    const store = new LibsqlSchedulerStore(recorder, testIdSource('shipped-writes'))
    // A claim token is fresh for every claim, as a tick's is, and the run carries it.
    let claims = 0
    const claimed = async (name: string, options: { maxAttempts?: number } = {}) => {
      const spawned = await store.spawn('q', name, '{}', options)
      claims += 1
      const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
      if (!run || run.taskId !== spawned.taskId) throw new Error(`expected to claim ${name}`)
      return run
    }
    const started = async (name: string, options: { maxAttempts?: number } = {}) => {
      const run = await claimed(name, options)
      await store.activate('q', run.runId, run.claimToken, run.claimGen)
      return run
    }
    const deferred = await claimed('deferred')
    await store.deferLaunch('q', deferred.runId, deferred.claimToken, deferred.claimGen, 3600)
    const rescheduled = await started('rescheduled')
    await store.reschedule('q', rescheduled.runId, rescheduled.claimToken, { inSeconds: 3600 })
    const suspended = await started('suspended')
    await store.suspendRun(
      'q',
      suspended.runId,
      suspended.claimToken,
      { inSeconds: 3600 },
      { key: 'step', stateJson: '{}' },
    )
    const waiting = await started('waiting')
    await store.awaitEvent(
      'q',
      waiting.taskId,
      waiting.runId,
      waiting.claimToken,
      'step',
      'event',
      null,
    )
    await store.emitEvent('q', 'event', '{}')
    const [woken] = await store.claim('q', 'worker-woken', { leaseSeconds: 60, limit: 1 })
    if (woken?.taskId !== waiting.taskId) throw new Error('expected to claim the woken run')
    await store.activate('q', woken.runId, woken.claimToken, woken.claimGen)
    await store.complete('q', woken.runId, woken.claimToken, '{}')
    const retried = await started('fails-and-retries', { maxAttempts: 2 })
    await store.fail('q', retried.runId, retried.claimToken, '{}', { delaySeconds: 3600 })
    const failed = await started('fails', { maxAttempts: 1 })
    await store.fail('q', failed.runId, failed.claimToken, '{}', null)
    await store.retryTask('q', failed.taskId)
    await store.cancelTask('q', failed.taskId)
    // One run whose launch is lost and one whose worker dies, then the clock passes both leases.
    await claimed('launch-is-lost')
    await started('worker-dies')
    await admin.setFakeNowEpochMs(1_000_000 + 120_000)
    await store.sweep('q', 10)
    const writes = seen.filter((st) => /^\s*(update|delete)\s/i.test(st.sql))
    const labels = new Set(writes.map((st) => st.label))
    expect(REACHED.filter((label) => !labels.has(label))).toEqual([])
    return writes
  }

  it('never scans the table it writes', async () => {
    const scans: string[] = []
    for (const st of await shippedWrites()) {
      const table = /^\s*(?:update|delete from)\s+"?([a-z_]+)"?/i.exec(st.sql)?.[1]
      if (table === undefined) throw new Error(`cannot name the table of: ${st.sql.slice(0, 60)}`)
      const p = await writePlan(st.sql, st.args as (string | number)[])
      const scanned = p
        .split('\n')
        .some((step) => new RegExp(`^SCAN ${table}\\b`).test(step.trim()))
      if (scanned) scans.push(`${st.label}: ${st.sql.trim().split(/\s+/).slice(0, 2).join(' ')}`)
    }
    expect([...new Set(scans)].sort()).toEqual([])
  })
})

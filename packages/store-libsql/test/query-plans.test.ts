import { type Client, createClient } from '@libsql/client'
import type { SqlExecutor } from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
  MIGRATIONS,
  NEXT_WAKE_SQL,
  SWEEP_SCAN_CANCELS_SQL,
  SWEEP_SCAN_EXPIRED_SQL,
} from '../src/index.js'

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
  await raw.execute(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  for (const m of MIGRATIONS) for (const s of m.statements) await raw.execute(s)
})

afterEach(() => {
  db.close()
  raw.close()
})

describe('claim candidate legs', () => {
  const leg = (state: string) => `
    SELECT r.run_id, r.available_at_ms FROM runs r
    WHERE r.queue = ? AND r.state = '${state}'
      AND r.available_at_ms IS NOT NULL AND r.available_at_ms <= ?
    ORDER BY r.available_at_ms, r.run_id LIMIT ?`

  it('the pending leg walks runs_poll in index order — no backlog sort', async () => {
    const p = await plan(leg('pending'), ['q', 0, 10])
    expect(p).toContain('runs_poll')
    expect(p).not.toContain('TEMP B-TREE')
  })

  it('the sleeping leg walks runs_poll in index order — no backlog sort', async () => {
    const p = await plan(leg('sleeping'), ['q', 0, 10])
    expect(p).toContain('runs_poll')
    expect(p).not.toContain('TEMP B-TREE')
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
    let n = 0
    const store = new LibsqlSchedulerStore(recorder, {
      uuidv7: () => `id-${++n}`,
      token: () => `tok-${n}`,
    })
    await store.emitEvent('q', 'e', '{}')
    // emitEvent writes runs exactly once. If that stops being true the pin
    // must be rewritten rather than silently pinning whichever came first.
    const updates = seen.filter((st) => /^\s*UPDATE runs\b/.test(st.sql))
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  it('is driven by the waits index, not by a scan of runs', async () => {
    const st = await shippedWakeStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(p).toContain('waits_event')
    expect(p).toContain('SEARCH runs USING PRIMARY KEY')
    expect(p).not.toContain('SCAN runs')
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

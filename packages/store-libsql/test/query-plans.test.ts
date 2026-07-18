import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibsqlExecutor, LibsqlStoreAdmin } from '../src/index.js'

/**
 * Query-plan pinning (prevention suite, per the standing rule): the
 * adversarial review found hot queries silently degrading to full scans and
 * temp b-trees because indexes drifted from query shapes. These tests make
 * that class of regression a test failure: every hot path must hit its
 * intended index and never sort the backlog.
 */

let db: LibsqlExecutor

async function plan(sql: string, args: (string | number)[] = []): Promise<string> {
  const [r] = await db.batch('plan', [{ sql: `EXPLAIN QUERY PLAN ${sql}`, args }], 'read')
  return (r?.rows ?? []).map((row) => String(row.detail)).join('\n')
}

beforeEach(async () => {
  db = LibsqlExecutor.open(':memory:')
  await new LibsqlStoreAdmin(db).migrate()
})

afterEach(() => {
  db.close()
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

import { Rng, seededIdSource, SimWorld } from '@durablerun/harness'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const Q = 'q'

/**
 * Red/green regression suite for the PR1.5 review findings (repo rule: every
 * bug lands as a red-test commit first, then the fix commit). Each test
 * FAILED against the pre-fix sweep implementation; the finding it pins is
 * named in the test title.
 */

describe('PR1.5 review regressions', () => {
  it('losing sweeper can never terminally fail a task whose successor lives (stamp fencing)', async () => {
    const corruptSeeds: number[] = []
    for (let seed = 0; seed < 150; seed++) {
      const f = await makeLibsqlFixture(`race-${seed}`)
      await f.admin.setFakeNowEpochMs(1_000_000)
      const spawned = await f.store.spawn(Q, 'job', '{}')
      // The boundary the reviewed interleaving needs: one infra retry left.
      await f.raw.batch('t', [
        { sql: `UPDATE tasks SET infra_retries = 19 WHERE task_id = ?`, args: [spawned.taskId] },
      ])
      const [run] = await f.store.claim(Q, 'w0', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected claim')
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await f.admin.setFakeNowEpochMs(1_100_000) // lease long expired

      const world = new SimWorld(f.raw, seed)
      for (const name of ['sweeper-a', 'sweeper-b']) {
        world.actor(name, async (simDb) => {
          await f.storeOver(simDb).sweep(Q, 10)
        })
      }
      // A late tick: advances time past the successor backoff, then claims —
      // the schedule where this lands between the winner's and the loser's
      // per-run batches is the reviewed corruption window.
      world.actor('late-tick', async (simDb) => {
        await simDb.batch('advance', [
          {
            sql: `INSERT INTO meta (key, value) VALUES ('fake_now_ms', '1107000')
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            args: [],
          },
        ])
        await f.storeOver(simDb).claim(Q, 'late', { leaseSeconds: 60, limit: 1 })
      })
      await world.run()

      const violations = await engineInvariantViolations(f.raw)
      if (violations.length > 0) corruptSeeds.push(seed)
      f.close()
    }
    expect(corruptSeeds, 'seeds reaching an invariant-violating state').toEqual([])
  })

  it('max_delay never cancels a task that started on time', async () => {
    const f = await makeLibsqlFixture('max-delay')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}', { cancellation: { maxDelaySeconds: 30 } })
    const [run] = await f.store.claim(Q, 't1', { leaseSeconds: 600, limit: 1 })
    if (!run) throw new Error('expected claim')
    // Started at t+10s — comfortably inside the 30s window.
    await f.admin.setFakeNowEpochMs(1_010_000)
    expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
    // Past the (disarmed) spawn deadline: nothing must be cancelled.
    await f.admin.setFakeNowEpochMs(1_031_000)
    const swept = await f.store.sweep(Q, 10)
    expect(swept.filter((s) => s.kind === 'cancelled')).toEqual([])
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [run.taskId] },
    ])
    expect(task?.rows[0]?.state).toBe('running')
    f.close()
  })

  it('a lost-launch reopen mirrors the task back to pending (no phantom running task)', async () => {
    const f = await makeLibsqlFixture('mirror')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 1 }) // never activated
    await f.admin.setFakeNowEpochMs(1_100_000)
    const swept = await f.store.sweep(Q, 10)
    expect(swept[0]?.kind).toBe('lost-launch')
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]?.state).toBe('pending')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it("sweep-terminal transitions delete the dead run's waits (no orphan waits)", async () => {
    const f = await makeLibsqlFixture('waits')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, created_at_ms)
              VALUES (?, 's1', ?, ?, 'e1', 1000000)`,
        args: [run.runId, Q, spawned.taskId],
      },
    ])
    await f.admin.setFakeNowEpochMs(1_100_000)
    const swept = await f.store.sweep(Q, 10)
    expect(swept[0]?.kind).toBe('claim-timeout')
    const [waits] = await f.raw.batch('t', [
      { sql: `SELECT COUNT(*) AS n FROM waits WHERE run_id = ?`, args: [run.runId] },
    ])
    expect(Number(waits?.rows[0]?.n)).toBe(0)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('claim does not move tasks.attempts — it moves only on user failures (TLA accounting)', async () => {
    const f = await makeLibsqlFixture('attempts')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 1 })
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(0)
    f.close()
  })

  it('sweep(limit) bounds TOTAL transitions across cancellations and expiries', async () => {
    const f = await makeLibsqlFixture('budget')
    await f.admin.setFakeNowEpochMs(1_000_000)
    // Two expired-lease runs, claimed BEFORE the cancellable tasks exist so
    // the two backlogs are disjoint...
    await f.store.spawn(Q, 'e1', '{}')
    await f.store.spawn(Q, 'e2', '{}')
    const claimed = await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 10 })
    expect(claimed).toHaveLength(2)
    // ...and two deadline-cancellable tasks that are never claimed.
    await f.store.spawn(Q, 'c1', '{}', { cancellation: { maxDelaySeconds: 10 } })
    await f.store.spawn(Q, 'c2', '{}', { cancellation: { maxDelaySeconds: 10 } })
    await f.admin.setFakeNowEpochMs(1_200_000)
    const swept = await f.store.sweep(Q, 2)
    expect(swept.length).toBeLessThanOrEqual(2)
    f.close()
  })

  it('negative and zero sweep limits do nothing (SQLite LIMIT -1 is unlimited)', async () => {
    const f = await makeLibsqlFixture('neg-limit')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 1 })
    await f.admin.setFakeNowEpochMs(1_100_000)
    expect(await f.store.sweep(Q, -1)).toEqual([])
    expect(await f.store.sweep(Q, 0)).toEqual([])
    f.close()
  })

  it('expireLeaseNow returns false for an already-expired lease', async () => {
    const f = await makeLibsqlFixture('expire')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.admin.setFakeNowEpochMs(1_100_000) // lease already past
    expect(await f.store.expireLeaseNow(Q, run.runId, run.claimToken)).toBe(false)
    f.close()
  })

  it('a successor-id collision fails loudly instead of booking a foreign run', async () => {
    const f = await makeLibsqlFixture('collide')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    // Seeded ids are deterministic: replay the same stream to predict the
    // successor id the sweep will mint (spawn consumed two uuidv7s).
    const mirror = seededIdSource(new Rng('collide'))
    mirror.uuidv7()
    mirror.uuidv7()
    const predictedSuccessor = mirror.uuidv7()
    // Park a FOREIGN run under a different task at exactly that id.
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
                max_attempts, enqueue_at_ms, created_at_ms, state)
              VALUES ('foreign-task', ?, 'x', '{}', '{"kind":"none"}', 1, 1000000, 1000000, 'completed')`,
        args: [Q],
      },
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, created_at_ms)
              VALUES (?, ?, 'foreign-task', 1, 'completed', 1000000)`,
        args: [predictedSuccessor, Q],
      },
    ])
    const [run] = await f.store.claim(Q, 'w0', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.admin.setFakeNowEpochMs(1_100_000)
    // The collision must surface loudly — never silent bookkeeping against
    // a foreign row.
    await expect(f.store.sweep(Q, 10)).rejects.toThrow()
    const [task] = await f.raw.batch('t', [
      {
        sql: `SELECT infra_retries, last_attempt_run FROM tasks WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    expect(Number(task?.rows[0]?.infra_retries)).toBe(0)
    expect(task?.rows[0]?.last_attempt_run).not.toBe(predictedSuccessor)
    f.close()
  })

  it('a losing cancel executes none of its follow-ons', async () => {
    const f = await makeLibsqlFixture('lose-cancel')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    expect(await f.store.cancelTask(Q, spawned.taskId)).toBe(true)
    // Construct a divergent future state: a live run under the cancelled
    // task (no transition creates one today; a future one might).
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
              VALUES ('later-run', ?, ?, 9, 'pending', 1000000, 1000000)`,
        args: [Q, spawned.taskId],
      },
    ])
    expect(await f.store.cancelTask(Q, spawned.taskId)).toBe(false)
    const [row] = await f.raw.batch('t', [
      { sql: `SELECT state FROM runs WHERE run_id = 'later-run'`, args: [] },
    ])
    // The loser's CAS matched nothing, so its follow-ons must touch nothing.
    expect(row?.rows[0]?.state).toBe('pending')
    f.close()
  })
})

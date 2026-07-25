import type { SqlExecutor } from '@durablerun/core'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'

/**
 * Replays where TIME PASSED between the original batch and the replay.
 *
 * The existing duplicate-injection tests replay a batch immediately, back to
 * back, so every row still looks exactly as the batch left it. That hides a
 * whole class: a fence proves a row CURRENTLY carries a stamp, which is not
 * the same as proving this batch WROTE it. A later batch that legitimately
 * transitions the same row overwrites the stamp, and a discriminator built on
 * "is my stamp still there" silently flips its answer.
 *
 * These drive the real operations, let the world move on, and then replay.
 */

const Q = 'q'
const NOW = 1_000_000

async function fixture() {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  await admin.setFakeNowEpochMs(NOW)
  let n = 0
  const ids = { uuidv7: () => `id-${++n}`, token: () => `tok-${n}` }
  return {
    raw,
    admin,
    store: new LibsqlSchedulerStore(raw, ids),
    storeOver: (db: SqlExecutor) => new LibsqlSchedulerStore(db, ids),
    close: () => raw.close(),
  }
}

async function query(
  raw: LibsqlExecutor,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<Record<string, unknown>[]> {
  const [rows] = await raw.batch('probe', [{ sql, args }], 'read')
  return (rows?.rows ?? []) as unknown as Record<string, unknown>[]
}

/**
 * Re-executes the exact statements of the first batch carrying `label`, the
 * way a retried request or a duplicated delivery would. Recording the
 * compiled statements is the point: a replay must bind the SAME stamps.
 */
function recorder(raw: LibsqlExecutor) {
  const seen: { label: string; statements: { sql: string; args: unknown[] }[] }[] = []
  const db: SqlExecutor = {
    batch: (label, statements, mode) => {
      seen.push({
        label,
        statements: statements.map((s) => ({ sql: s.sql, args: [...s.args] })),
      })
      return raw.batch(label, statements, mode)
    },
  }
  return {
    db,
    replay: (label: string) => {
      const call = seen.find((c) => c.label === label)
      if (!call) throw new Error(`no batch labelled ${label} was recorded`)
      return raw.batch(
        label,
        call.statements as { sql: string; args: never[] }[],
        label.startsWith('sweep:scan') ? 'read' : 'write',
      )
    },
  }
}

describe('a replay after the world moved on', () => {
  it('does not terminalize a task whose successor has since been claimed', async () => {
    // 1. Run 1 of a two-attempt task fails with a retry, creating run 2.
    // 2. The response is lost, so the caller does not know it committed.
    // 3. A tick claims run 2 — which overwrites run 2's provenance, because
    //    claiming is itself a transition that stamps the row.
    // 4. The original batch is delivered again.
    //
    // The failure arm asks "did I create the successor" by looking for its
    // stamp. Step 3 removed that stamp, so the answer flips from yes to no
    // and the terminal arm fires: the task is failed permanently while its
    // successor is running under a live worker. The run cannot activate under
    // a terminal task, so a perfectly good retry is lost and the task reports
    // a failure that never happened.
    const f = await fixture()
    const rec = recorder(f.raw)
    const store = f.storeOver(rec.db)

    const spawned = await store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
    const [run] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await store.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })

    const [successor] = await query(
      f.raw,
      `SELECT run_id FROM runs WHERE task_id = ? AND attempt = 2`,
      [spawned.taskId],
    )
    const successorId = String(successor?.run_id)

    // The world moves on: the successor is claimed by another tick.
    const [claimed] = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    expect(claimed?.runId).toBe(successorId)

    await rec.replay('fail')

    const [task] = await query(f.raw, `SELECT state, failure_reason FROM tasks WHERE task_id = ?`, [
      spawned.taskId,
    ])
    expect(task?.state).toBe('running') // NOT failed — its successor is live
    const [after] = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [successorId])
    expect(after?.state).toBe('running')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('does not terminalize when an infrastructure successor has since been claimed', async () => {
    // The same shape through the sweep's claim-timeout path.
    const f = await fixture()
    const rec = recorder(f.raw)
    const store = f.storeOver(rec.db)

    const spawned = await store.spawn(Q, 'job', '{}')
    const [run] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.admin.setFakeNowEpochMs(NOW + 100_000) // lease expired
    const swept = await store.sweep(Q, 10)
    expect(swept[0]?.kind).toBe('claim-timeout')

    await f.admin.setFakeNowEpochMs(NOW + 200_000)
    const [claimed] = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!claimed) throw new Error('expected the successor to be claimable')

    await rec.replay('sweep:claim-timeout')

    const [task] = await query(f.raw, `SELECT state FROM tasks WHERE task_id = ?`, [spawned.taskId])
    expect(task?.state).toBe('running')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })
})

describe('emitEvent only wakes runs that are parked on that event', () => {
  it('leaves a timer sleep alone when a stale wait row names its run', async () => {
    // A run sleeping on a durable timer until much later, plus a leftover
    // waiting row naming that run and some event. The emit sees the wait,
    // wakes the run and deletes the wait — so the run resumes roughly a
    // thousand seconds early and the evidence is gone. Replay then sees the
    // sleep checkpoint already recorded and treats the sleep as finished, so
    // user code continues as though it had slept.
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    // A plain timer sleep: no wake_event, wakes at NOW + 1_000_000.
    await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 1000 })

    await f.raw.batch('t', [
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
              VALUES (?, '$await:go', ?, ?, 'go', 'waiting', ?)`,
        args: [run.runId, Q, spawned.taskId, NOW],
      },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [after] = await query(
      f.raw,
      `SELECT state, available_at_ms, wake_event FROM runs WHERE run_id = ?`,
      [run.runId],
    )
    expect(after?.state).toBe('sleeping') // still asleep
    expect(after?.available_at_ms).toBe(NOW + 1_000_000) // at its own deadline
    expect(after?.wake_event).toBeNull()
    f.close()
  })

  it('does not deliver event B to a run parked on event A', async () => {
    // The run is legitimately parked, so the timer-sleep case does not cover
    // this: it is awaiting 'A', and a stale waiting row for 'B' names it at
    // the same step. Delivering B here hands user code a payload for an event
    // it never asked for, and resumes it at a step whose await has not
    // completed. Only the wake_event match rules it out.
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.awaitEvent(Q, spawned.taskId, run.runId, run.claimToken, '$await:A', 'A', null)

    // The run's own wait is gone and a row for a DIFFERENT event occupies its
    // step — corrupt state, which rule 6 says must not be amplified. Only the
    // wake_event match rules it out; the step match cannot, because the step
    // is exactly the one the run is parked at.
    await f.raw.batch('t', [
      { sql: `DELETE FROM waits WHERE run_id = ?`, args: [run.runId] },
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
              VALUES (?, '$await:A', ?, ?, 'B', 'waiting', ?)`,
        args: [run.runId, Q, spawned.taskId, NOW],
      },
    ])

    await f.store.emitEvent(Q, 'B', '{"wrong":1}')

    const [after] = await query(
      f.raw,
      `SELECT state, wake_event, event_payload FROM runs WHERE run_id = ?`,
      [run.runId],
    )
    expect({ state: after?.state, wake: after?.wake_event }).toEqual({
      state: 'sleeping',
      wake: 'A',
    })
    expect(after?.event_payload).toBeNull()
    f.close()
  })

  it('does not let one await step consume another step of the same event', async () => {
    // A run may await the same event name at two call sites. Each await
    // carries its own step key, which is the entire reason wake_step exists.
    // Here the run is parked at one step and a leftover waiting row for the
    // same event sits at another; without the step match the wake is
    // delivered against an await that never registered it.
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.awaitEvent(
      Q,
      spawned.taskId,
      run.runId,
      run.claimToken,
      '$await:go#2',
      'go',
      null,
    )
    // A leftover from the FIRST call site, at a different step.
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
              VALUES (?, '$await:go#1', ?, ?, 'go', 'waiting', ?)`,
        args: [run.runId, Q, spawned.taskId, NOW - 1],
      },
      // Remove the run's OWN wait, leaving only the other step's.
      {
        sql: `DELETE FROM waits WHERE run_id = ? AND step_name = '$await:go#2'`,
        args: [run.runId],
      },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [after] = await query(f.raw, `SELECT state, event_payload FROM runs WHERE run_id = ?`, [
      run.runId,
    ])
    expect(after?.state).toBe('sleeping') // its own await never registered this
    expect(after?.event_payload).toBeNull()
    f.close()
  })

  it('still wakes a run parked before wake_step existed', async () => {
    // Waits and events predate the wake_step column; the migration that added
    // it backfills nothing. A run parked by the older code is sleeping with
    // wake_event set and wake_step NULL, and the step correlation compares
    // against NULL, which is never true — so the run is not woken, while the
    // delete removes its wait row regardless. The event is immutable and the
    // wait is gone, so re-emitting cannot help: an untimed await strands
    // forever. Reachable by upgrading a database, and by a rolling deploy
    // where an older process parks a run after a newer one has migrated.
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.awaitEvent(Q, spawned.taskId, run.runId, run.claimToken, '$await:go', 'go', null)
    // Exactly what the pre-v3 code left behind: no step recorded on the run.
    await f.raw.batch('t', [
      { sql: `UPDATE runs SET wake_step = NULL WHERE run_id = ?`, args: [run.runId] },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [after] = await query(f.raw, `SELECT state, event_payload FROM runs WHERE run_id = ?`, [
      run.runId,
    ])
    expect(after?.state).toBe('pending')
    expect(after?.event_payload).toBe('{"x":1}')
    f.close()
  })

  it('still wakes a run that really is parked on the event', async () => {
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    const parked = await f.store.awaitEvent(
      Q,
      spawned.taskId,
      run.runId,
      run.claimToken,
      '$await:go',
      'go',
      null,
    )
    expect(parked).toEqual({ emitted: false })

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [after] = await query(f.raw, `SELECT state, event_payload FROM runs WHERE run_id = ?`, [
      run.runId,
    ])
    expect(after?.state).toBe('pending')
    expect(after?.event_payload).toBe('{"x":1}')
    const [task] = await query(f.raw, `SELECT state FROM tasks WHERE task_id = ?`, [spawned.taskId])
    expect(task?.state).toBe('pending')
    f.close()
  })
})

describe('a successor id that collides with the run being replaced', () => {
  /**
   * The insert's "a run of my task already sits at that id" guard treats the
   * PARENT as such a run, so a self-collision makes it write nothing — and
   * then every arm keyed on the successor writes nothing too. What commits is
   * a half-transition: in the sweep, a failed run under a task still marked
   * running, which no later claim or sweep can rediscover; in a worker
   * failure with budget remaining, a permanently failed task the caller asked
   * to retry.
   *
   * A collision with a FOREIGN row fails loudly. This one must too: it is an
   * id-generation failure, and committing either outcome is worse than
   * raising.
   */
  it('fails loudly instead of committing a half-transition', async () => {
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)

    // An id source that hands back the id of the run being replaced.
    const colliding = new LibsqlSchedulerStore(f.raw, {
      uuidv7: () => run.runId,
      token: () => 'collide-tok',
    })
    await expect(
      colliding.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 0 }),
    ).rejects.toThrow()

    // Nothing of the half-transition committed: the batch is atomic.
    const [task] = await query(f.raw, `SELECT state FROM tasks WHERE task_id = ?`, [spawned.taskId])
    expect(task?.state).toBe('running')
    const [after] = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [run.runId])
    expect(after?.state).toBe('running')
    f.close()
  })
})

describe('an exact replay of spawn', () => {
  /**
   * A lost response makes the caller retry the same batch. The task insert
   * correctly writes nothing the second time -- the task exists -- but the
   * task still CARRIES the first pass's stamp, so the run follow-on matches
   * it and inserts the same run again, dying on the run's primary key.
   *
   * The caller sees an error for a spawn that fully succeeded. A retry
   * without an idempotency key then creates duplicate work. This is the same
   * class as the successor replay: a fence proves a row carries a stamp, not
   * that this execution wrote it.
   */
  it('returns the original receipt rather than colliding on the run', async () => {
    const f = await fixture()
    const rec = recorder(f.raw)
    const store = f.storeOver(rec.db)

    const first = await store.spawn(Q, 'job', '{}', { idempotencyKey: 'k' })
    expect(first.created).toBe(true)

    await rec.replay('spawn')

    // Exactly one task and one run: the replay added nothing.
    const [counts] = await query(
      f.raw,
      `SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM runs) AS runs`,
    )
    expect(counts).toMatchObject({ tasks: 1, runs: 1 })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })
})

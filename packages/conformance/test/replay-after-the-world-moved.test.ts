import type { SqlExecutor } from '@durablerun/core'
import { requireExpectedFailure } from '@durablerun/core/testing'
import { type LibsqlExecutor, LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
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
  const { raw, admin, ids } = await openTestDb({
    nowMs: NOW,
    idNamespace: 'world-moved',
  })
  return {
    raw,
    admin,
    store: new LibsqlSchedulerStore(raw, ids),
    storeOver: (db: SqlExecutor) => new LibsqlSchedulerStore(db, ids),
    close: async () => raw.close(),
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

const RUN_ID_COLLISION = /UNIQUE constraint failed: runs\.run_id/

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
  async function emittedWait() {
    const f = await fixture()
    const rec = recorder(f.raw)
    const store = f.storeOver(rec.db)
    const spawned = await store.spawn(Q, 'job', '{}')
    const [run] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await store.activate(Q, run.runId, run.claimToken, run.claimGen)
    const step = '$await:go'
    await store.awaitEvent(Q, spawned.taskId, run.runId, run.claimToken, step, 'go', null)
    await store.emitEvent(Q, 'go', '{"x":1}')
    return { f, rec, spawned, run, step }
  }

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
    await f.close()
  })

  it('does not reuse one emit provenance seed at a later instant', async () => {
    const { f, rec } = await emittedWait()
    await f.admin.setFakeNowEpochMs(NOW + 100_000)

    await rec.replay('emit-event')

    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('does not reuse an emit seed after a fresh emit overwrites its receipt', async () => {
    const { f, rec } = await emittedWait()
    await f.admin.setFakeNowEpochMs(NOW + 100_000)
    await f.store.emitEvent(Q, 'go', '{"x":2}')
    await f.admin.setFakeNowEpochMs(NOW + 200_000)

    await rec.replay('emit-event')

    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('does not let a delayed emit replay delete a restored registration', async () => {
    const { f, rec, spawned, run, step } = await emittedWait()
    await f.raw.batch('restore', [
      {
        sql: `INSERT INTO waits
                (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
              VALUES (?, ?, ?, ?, 'go', 'waiting', ?)`,
        args: [run.runId, step, Q, spawned.taskId, NOW],
      },
    ])
    await f.admin.setFakeNowEpochMs(NOW + 100_000)

    await rec.replay('emit-event')

    const [restored] = await query(
      f.raw,
      `SELECT COUNT(*) AS n FROM waits WHERE run_id = ? AND step_name = ?`,
      [run.runId, step],
    )
    expect(Number(restored?.n)).toBe(1)
    await f.close()
  })

  for (const suspension of ['reschedule', 'suspend'] as const) {
    it(`does not let a delayed ${suspension} replay delete a later wait`, async () => {
      const f = await fixture()
      const rec = recorder(f.raw)
      const store = f.storeOver(rec.db)
      const spawned = await store.spawn(Q, 'job', '{}')
      const [first] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!first) throw new Error('expected the first claim')
      await store.activate(Q, first.runId, first.claimToken, first.claimGen)

      if (suspension === 'reschedule') {
        await store.reschedule(Q, first.runId, first.claimToken, { inSeconds: 1 })
      } else {
        await store.suspendRun(
          Q,
          first.runId,
          first.claimToken,
          { inSeconds: 1 },
          { key: '$sleep:new-wait', stateJson: '{}' },
        )
      }

      // A later claim and park overwrite the old suspension stamp. Replaying
      // the exact old batch must therefore lose its CAS and its wait cleanup;
      // otherwise a delayed request can erase a registration created after it.
      await f.admin.setFakeNowEpochMs(NOW + 2_000)
      const [later] = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
      if (!later) throw new Error('expected the later claim')
      await store.activate(Q, later.runId, later.claimToken, later.claimGen)
      await store.awaitEvent(
        Q,
        spawned.taskId,
        later.runId,
        later.claimToken,
        '$await:later',
        'later',
        null,
      )

      await rec.replay(suspension)

      expect(
        await query(
          f.raw,
          `SELECT event_name FROM waits WHERE run_id = ? AND step_name = '$await:later'`,
          [later.runId],
        ),
      ).toEqual([{ event_name: 'later' }])
      await f.close()
    })
  }
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
    await f.close()
  })

  it('does not wake a run whose park is not this wait', async () => {
    // The three guards added earlier -- wake_event matches, wake_step matches,
    // a waiting row exists -- are each necessary and together still not
    // sufficient. A run asleep on an ordinary TIMER, belonging to a different
    // task, that never awaited anything, is woken by an emit as soon as those
    // three happen to line up: set its wake fields and give it a wait row.
    //
    // What separates it from a genuine waiter is that its available_at_ms is
    // its own timer deadline, not the wait's timeout -- which is exactly what
    // the `wait-timeout-availability-mismatch` invariant already says about
    // this pair. The invariant stated the relationship and the statement that
    // CONSUMES the state did not enforce it; worse, the emit then deleted the
    // wait row, so a state the invariant library could see became one it
    // could not.
    const f = await fixture()
    const a = await f.store.spawn(Q, 'job', '{}')
    const [ra] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!ra) throw new Error('expected a claim')
    await f.store.activate(Q, ra.runId, ra.claimToken, ra.claimGen)
    await f.store.awaitEvent(Q, a.taskId, ra.runId, ra.claimToken, '$await:go', 'go', null)

    const bTask = await f.store.spawn(Q, 'other', '{}')
    const [rb] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!rb) throw new Error('expected a claim')
    await f.store.activate(Q, rb.runId, rb.claimToken, rb.claimGen)
    await f.store.reschedule(Q, rb.runId, rb.claimToken, { inSeconds: 1000 })
    await f.raw.batch('t', [
      {
        sql: `UPDATE runs SET wake_event = 'go', wake_step = '$await:go' WHERE run_id = ?`,
        args: [rb.runId],
      },
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
              VALUES (?, '$await:go', ?, ?, 'go', 'waiting', ?)`,
        args: [rb.runId, Q, bTask.taskId, NOW],
      },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [woken] = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [ra.runId])
    expect(woken?.state).toBe('pending') // the genuine waiter still wakes
    const [timer] = await query(f.raw, `SELECT state, available_at_ms FROM runs WHERE run_id = ?`, [
      rb.runId,
    ])
    expect({ state: timer?.state, at: timer?.available_at_ms }).toEqual({
      state: 'sleeping',
      at: NOW + 1_000_000, // its own deadline, untouched
    })
    await f.close()
  })

  it('keeps the registration of a waiter it did not wake', async () => {
    // The old cleanup deleted every waiting row for the event, whether or not
    // its run was woken. Those two sets were kept in step by nothing but the
    // shape of the two WHERE clauses, and the delete's was the weaker one --
    // so every condition added to the wake predicate silently converted some
    // run from "not woken" into "not woken, and its registration destroyed".
    // The payload is already immutable and no future emit is guaranteed, so
    // an untimed await in that position can strand forever.
    //
    // Every legitimate way a run stops waiting already reaps its rows --
    // complete, fail, the sweeps and cancel all delete a run's waits -- so a
    // row this emit declines to honour is either repairable or evidence of
    // corruption, and it is worth exactly as much in either case. Deleting it
    // is the one option that makes it worth nothing.
    const f = await fixture()
    const a = await f.store.spawn(Q, 'job', '{}')
    const [ra] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!ra) throw new Error('expected a claim')
    await f.store.activate(Q, ra.runId, ra.claimToken, ra.claimGen)
    await f.store.awaitEvent(Q, a.taskId, ra.runId, ra.claimToken, '$await:go', 'go', null)

    const b = await f.store.spawn(Q, 'job', '{}')
    const [rb] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!rb) throw new Error('expected a claim')
    await f.store.activate(Q, rb.runId, rb.claimToken, rb.claimGen)
    await f.store.awaitEvent(Q, b.taskId, rb.runId, rb.claimToken, '$await:go', 'go', null)
    // B's park no longer agrees with its registration, so this emit will not
    // honour it. Its wait row is untouched and still describes a real await.
    await f.raw.batch('t', [
      { sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`, args: [NOW + 1000, rb.runId] },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const woken = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [ra.runId])
    expect(woken[0]?.state).toBe('pending')
    // A was woken, so its registration is spent and must be gone.
    expect(await query(f.raw, `SELECT 1 FROM waits WHERE run_id = ?`, [ra.runId])).toEqual([])
    // B was not, so its registration is all that is left of the request.
    expect(await query(f.raw, `SELECT step_name FROM waits WHERE run_id = ?`, [rb.runId])).toEqual([
      { step_name: '$await:go' },
    ])
    // And it is not kept quietly: a wait outliving its event is a lost wakeup
    // whichever way it happened, so it stands as an alarm until repaired --
    // which is the whole difference from deleting it.
    expect(await engineInvariantViolations(f.raw)).toContain(
      `wait-for-fired-event: ${rb.runId}/$await:go`,
    )
    await f.close()
  })

  it('does not re-deliver to a run whose timeout was already selected', async () => {
    // The reviewer's second counterexample, spelled out and executed rather
    // than argued away. Its whole point is that no field is corrupt: the run
    // really did await this event at this step, and the wait row really was
    // its own.
    //
    //   1. the timed wait expires; claim selects the timeout wake (event set,
    //      payload NULL) and deletes the wait row in the same batch
    //   2. a worker that cannot dispatch the task defers the launch, which
    //      consumes nothing -- so the run goes back to sleeping still
    //      carrying wake_event and wake_step
    //   3. a leftover row for that same await survives or is recreated
    //   4. the emit arrives
    //
    // Everything the predicate compared before this round now agrees: run,
    // event, step, status. What does not agree is the deadline -- the row
    // still carries the timeout the run was parked on originally, and the
    // run's available_at_ms is the deferral's new wake time. The outcome
    // matters: waking here replaces an ALREADY-SELECTED timeout with an event
    // success, so a workflow that timed out is told it did not.
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.awaitEvent(Q, spawned.taskId, run.runId, run.claimToken, '$await:go', 'go', 30)
    const [parked] = await query(f.raw, `SELECT timeout_at_ms FROM waits WHERE run_id = ?`, [
      run.runId,
    ])
    // The disagreement under test IS this deadline; without it the fixture
    // silently becomes the untimed-wait case above.
    expect(typeof parked?.timeout_at_ms).toBe('number')
    const parkedTimeout = Number(parked?.timeout_at_ms)

    // The timeout fires: claim delivers it and takes the wait row with it.
    await f.admin.setFakeNowEpochMs(NOW + 31_000)
    const [timedOut] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!timedOut) throw new Error('expected the timeout wake')
    expect(timedOut.wake).toEqual({ event: 'go', step: '$await:go', timedOut: true })
    expect(await query(f.raw, `SELECT 1 FROM waits WHERE run_id = ?`, [run.runId])).toEqual([])

    // A worker that cannot dispatch defers the launch, keeping the carried wake.
    await f.store.deferLaunch(Q, run.runId, timedOut.claimToken, timedOut.claimGen, 1000)
    // The row comes back -- a replayed registration, a restored backup, a
    // straggling older process -- carrying the deadline it was written with.
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                timeout_at_ms, created_at_ms)
              VALUES (?, '$await:go', ?, ?, 'go', 'waiting', ?, ?)`,
        args: [run.runId, Q, spawned.taskId, parkedTimeout, NOW],
      },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [after] = await query(
      f.raw,
      `SELECT state, available_at_ms, event_payload FROM runs WHERE run_id = ?`,
      [run.runId],
    )
    expect({
      state: after?.state,
      at: after?.available_at_ms,
      payload: after?.event_payload,
    }).toEqual({
      state: 'sleeping',
      at: NOW + 31_000 + 1_000_000, // the deferral's wake time, untouched
      payload: null, // still the timeout it already selected
    })
    await f.close()
  })

  it('still wakes a run parked before wake_step existed', async () => {
    // Waits and events predate the wake_step column; the migration that added
    // it backfills nothing. A run parked by the older code is sleeping with
    // wake_event set and wake_step NULL, and the step correlation compares
    // against NULL, which is never true — so the run is not woken, while the
    // delete removes its wait row regardless. With the wait gone, no future
    // delivery is guaranteed to repair it, so an untimed await strands
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
    await f.close()
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
    await f.close()
  })
})

describe('the successor collision rejection oracle', () => {
  it('propagates an unrelated pre-transition failure', async () => {
    const unrelated = new TypeError('unrelated pre-transition failure')
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'successor-collision-error-attribution' },
      (error) => error === unrelated,
      () =>
        requireExpectedFailure(
          { kind: 'behavior', mutation: 'successor-attempt-identity' },
          RUN_ID_COLLISION,
          async () => {
            throw unrelated
          },
        ),
    )
  })
})

describe('successor identity includes its task and intended attempt', () => {
  async function runningRetry(maxAttempts = 5) {
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts })
    const [historical] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!historical) throw new Error('expected the first claim')
    await f.store.activate(Q, historical.runId, historical.claimToken, historical.claimGen)
    await f.store.fail(Q, historical.runId, historical.claimToken, '{"name":"First"}', {
      delaySeconds: 0,
    })
    const [current] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!current) throw new Error('expected the retry claim')
    await f.store.activate(Q, current.runId, current.claimToken, current.claimGen)
    return { f, spawned, historical, current }
  }

  function collidingStore(raw: LibsqlExecutor, historicalRunId: string) {
    let tokens = 0
    return new LibsqlSchedulerStore(raw, {
      uuidv7: () => historicalRunId,
      token: () => `historical-collision-${++tokens}`,
    })
  }

  async function transitionOutcome(action: () => Promise<unknown>) {
    try {
      await action()
      return 'resolved' as const
    } catch (error) {
      return RUN_ID_COLLISION.test(String(error))
        ? ('run-id-collision' as const)
        : (`unexpected:${String(error)}` as const)
    }
  }

  async function observeSelfCollision() {
    const f = await fixture()
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
      const [current] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!current) throw new Error('expected a claim')
      await f.store.activate(Q, current.runId, current.claimToken, current.claimGen)
      const colliding = collidingStore(f.raw, current.runId)
      const outcome = await transitionOutcome(() =>
        colliding.fail(Q, current.runId, current.claimToken, '{"name":"Boom"}', {
          delaySeconds: 0,
        }),
      )
      const [task] = await query(
        f.raw,
        `SELECT state, failure_reason FROM tasks WHERE task_id = ?`,
        [spawned.taskId],
      )
      const [run] = await query(f.raw, `SELECT state, failure_reason FROM runs WHERE run_id = ?`, [
        current.runId,
      ])
      const [count] = await query(f.raw, `SELECT COUNT(*) AS count FROM runs WHERE task_id = ?`, [
        spawned.taskId,
      ])
      return {
        outcome,
        task: { state: task?.state, failureReason: task?.failure_reason },
        current: { state: run?.state, failureReason: run?.failure_reason },
        runCount: Number(count?.count),
        invariants: await engineInvariantViolations(f.raw),
      }
    } finally {
      await f.close()
    }
  }

  async function observeHistoricalCollision(transition: 'fail' | 'sweep') {
    const { f, spawned, historical, current } = await runningRetry()
    try {
      const colliding = collidingStore(f.raw, historical.runId)
      if (transition === 'sweep') await f.admin.setFakeNowEpochMs(NOW + 100_000)
      const outcome = await transitionOutcome(() =>
        transition === 'fail'
          ? colliding.fail(Q, current.runId, current.claimToken, '{"name":"Second"}', {
              delaySeconds: 0,
            })
          : colliding.sweep(Q, 10),
      )
      const [task] = await query(
        f.raw,
        `SELECT state, failure_reason FROM tasks WHERE task_id = ?`,
        [spawned.taskId],
      )
      const [prior] = await query(
        f.raw,
        `SELECT state, failure_reason FROM runs WHERE run_id = ?`,
        [historical.runId],
      )
      const [run] = await query(f.raw, `SELECT state, failure_reason FROM runs WHERE run_id = ?`, [
        current.runId,
      ])
      const [count] = await query(f.raw, `SELECT COUNT(*) AS count FROM runs WHERE task_id = ?`, [
        spawned.taskId,
      ])
      return {
        outcome,
        task: { state: task?.state, failureReason: task?.failure_reason },
        historical: { state: prior?.state, failureReason: prior?.failure_reason },
        current: { state: run?.state, failureReason: run?.failure_reason },
        runCount: Number(count?.count),
        invariants: await engineInvariantViolations(f.raw),
      }
    } finally {
      await f.close()
    }
  }

  async function observeAtCapSelfCollision() {
    const { f, spawned, historical, current } = await runningRetry(2)
    try {
      const colliding = collidingStore(f.raw, current.runId)
      const outcome = await transitionOutcome(() =>
        colliding.fail(Q, current.runId, current.claimToken, '{"name":"Second"}', {
          delaySeconds: 0,
        }),
      )
      const [task] = await query(
        f.raw,
        `SELECT state, failure_reason FROM tasks WHERE task_id = ?`,
        [spawned.taskId],
      )
      const [prior] = await query(
        f.raw,
        `SELECT state, failure_reason FROM runs WHERE run_id = ?`,
        [historical.runId],
      )
      const [run] = await query(f.raw, `SELECT state, failure_reason FROM runs WHERE run_id = ?`, [
        current.runId,
      ])
      const [count] = await query(f.raw, `SELECT COUNT(*) AS count FROM runs WHERE task_id = ?`, [
        spawned.taskId,
      ])
      return {
        outcome,
        task: { state: task?.state, failureReason: task?.failure_reason },
        historical: { state: prior?.state, failureReason: prior?.failure_reason },
        current: { state: run?.state, failureReason: run?.failure_reason },
        runCount: Number(count?.count),
        invariants: await engineInvariantViolations(f.raw),
      }
    } finally {
      await f.close()
    }
  }

  it('rejects self and historical collisions while terminalizing an at-cap failure', async () => {
    expect(
      {
        self: await observeSelfCollision(),
        historicalFail: await observeHistoricalCollision('fail'),
        historicalSweep: await observeHistoricalCollision('sweep'),
        atCapSelf: await observeAtCapSelfCollision(),
      },
      'mutation-verdict:behavior:successor-attempt-identity',
    ).toEqual({
      self: {
        outcome: 'run-id-collision',
        task: { state: 'running', failureReason: null },
        current: { state: 'running', failureReason: null },
        runCount: 1,
        invariants: [],
      },
      historicalFail: {
        outcome: 'run-id-collision',
        task: { state: 'running', failureReason: null },
        historical: { state: 'failed', failureReason: '{"name":"First"}' },
        current: { state: 'running', failureReason: null },
        runCount: 2,
        invariants: [],
      },
      historicalSweep: {
        outcome: 'run-id-collision',
        task: { state: 'running', failureReason: null },
        historical: { state: 'failed', failureReason: '{"name":"First"}' },
        current: { state: 'running', failureReason: null },
        runCount: 2,
        invariants: [],
      },
      atCapSelf: {
        outcome: 'resolved',
        task: { state: 'failed', failureReason: '{"name":"Second"}' },
        historical: { state: 'failed', failureReason: '{"name":"First"}' },
        current: { state: 'failed', failureReason: '{"name":"Second"}' },
        runCount: 2,
        invariants: [],
      },
    })
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
    await f.close()
  })
})

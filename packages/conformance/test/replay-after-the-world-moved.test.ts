import type { SqlExecutor } from '@durablerun/core'
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

  it('does not reuse one emit provenance seed at a later instant', async () => {
    const { f, rec } = await emittedWait()
    await f.admin.setFakeNowEpochMs(NOW + 100_000)

    await rec.replay('emit-event')

    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('does not reuse an emit seed after a fresh emit overwrites its receipt', async () => {
    const { f, rec } = await emittedWait()
    await f.admin.setFakeNowEpochMs(NOW + 100_000)
    await f.store.emitEvent(Q, 'go', '{"x":2}')
    await f.admin.setFakeNowEpochMs(NOW + 200_000)

    await rec.replay('emit-event')

    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
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
    f.close()
  })

  it('does not wake a run whose evidence is split across two wait rows', async () => {
    // The wake predicate asks two separate questions of the `waits` table: an
    // `IN` that lists the run ids waiting in this queue for this event, and an
    // `EXISTS` that checks the step and the deadline. Nothing requires the two
    // to be answered by the SAME ROW. The `IN` never looks at the step; the
    // `EXISTS` never looks at the queue. So two rows that are each individually
    // wrong combine into a wake that no single registration justifies:
    //
    //   row 1  (this queue, this event, WRONG step)   satisfies the IN
    //   row 2  (WRONG queue, this event, right step)  satisfies the EXISTS
    //
    // The run wakes, and the delete then removes only row 1 -- it filters on
    // the queue -- so the leftover row 2 stays waiting under a run that is now
    // pending, which is the `wait-on-non-sleeping-run` violation.
    //
    // Each condition was added against a specific counterexample, and each was
    // correct about its own; the hole is that "a legitimate registration
    // exists" was never expressed as one row having all of the properties.
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.awaitEvent(Q, spawned.taskId, run.runId, run.claimToken, '$await:go', 'go', null)

    await f.raw.batch('t', [
      // Its real registration, moved to another step: still in this queue, so
      // it still answers the IN, but it no longer answers the step check.
      {
        sql: `UPDATE waits SET step_name = '$await:go#stale' WHERE run_id = ?`,
        args: [run.runId],
      },
      // A row in a DIFFERENT queue at the right step: answers the EXISTS,
      // which never constrains the queue.
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
              VALUES (?, '$await:go', 'elsewhere', ?, 'go', 'waiting', ?)`,
        args: [run.runId, spawned.taskId, NOW],
      },
    ])

    // The state is already inconsistent -- that is what makes it a
    // counterexample -- so the question is not whether violations exist but
    // what the emit does to them. Declining to wake is only half of right:
    // an emit that also erased the rows proving why would leave a database
    // that looks clean and has silently dropped a wakeup. So nothing may
    // disappear, and the declined registration must show up as the alarm for
    // a wait outliving its event.
    const before = await engineInvariantViolations(f.raw)

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [after] = await query(f.raw, `SELECT state, event_payload FROM runs WHERE run_id = ?`, [
      run.runId,
    ])
    expect(after?.state).toBe('sleeping')
    expect(after?.event_payload).toBeNull()
    const now = await engineInvariantViolations(f.raw)
    expect(now).toEqual(expect.arrayContaining(before))
    expect(now).toContain(`wait-for-fired-event: ${run.runId}/$await:go#stale`)
    f.close()
  })

  it('keeps the registration of a waiter it did not wake', async () => {
    // The cleanup deletes every waiting row for the event, whether or not its
    // run was woken. Those two sets are kept in step by nothing but the shape
    // of the two WHERE clauses, and the delete's is the weaker one -- so every
    // condition ever added to the wake predicate silently converts some run
    // from "not woken" into "not woken, and its registration destroyed". The
    // the payload is already immutable and no future emit is guaranteed, so
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
    f.close()
  })

  it('does not re-deliver to a run whose timeout was already selected', async () => {
    // The reviewer's second counterexample, spelled out and executed rather
    // than argued away. Its whole point is that no field is corrupt: the run
    // really did await this event at this step, and the wait row really was
    // its own.
    //
    //   1. the timed wait expires; claim selects the timeout wake (event set,
    //      payload NULL) and deletes the wait row in the same batch
    //   2. a worker that cannot dispatch the task defers with 'preserve',
    //      which consumes nothing -- so the run goes back to sleeping still
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

    // A driver that cannot dispatch defers it, preserving the carried wake.
    await f.store.reschedule(Q, run.runId, timedOut.claimToken, { inSeconds: 1000 }, 'preserve')
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
    f.close()
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

describe('a successor id that collides with a historical run of the same task', () => {
  async function runningRetry() {
    const f = await fixture()
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 5 })
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

  it('rejects a worker failure instead of committing a half-transition', async () => {
    const { f, spawned, historical, current } = await runningRetry()
    const colliding = collidingStore(f.raw, historical.runId)

    await expect(
      colliding.fail(Q, current.runId, current.claimToken, '{"name":"Second"}', {
        delaySeconds: 0,
      }),
    ).rejects.toThrow()

    const [task] = await query(f.raw, `SELECT state FROM tasks WHERE task_id = ?`, [spawned.taskId])
    expect(task?.state).toBe('running')
    const [run] = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [current.runId])
    expect(run?.state).toBe('running')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('rejects a claim-timeout sweep instead of committing a half-transition', async () => {
    const { f, spawned, historical, current } = await runningRetry()
    const colliding = collidingStore(f.raw, historical.runId)
    await f.admin.setFakeNowEpochMs(NOW + 100_000)

    await expect(colliding.sweep(Q, 10)).rejects.toThrow()

    const [task] = await query(f.raw, `SELECT state FROM tasks WHERE task_id = ?`, [spawned.taskId])
    expect(task?.state).toBe('running')
    const [run] = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [current.runId])
    expect(run?.state).toBe('running')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
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

import { type IdSource, LeaseLostError, type SqlExecutor } from '@durablerun/core'
import { attributeExpectedFailure } from '@durablerun/core/testing'
import { SimWorld } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'
import { claimActivated, claimOne } from '../src/scenario.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const Q = 'q'

/**
 * Give one operation an exact collision without predicting a fixture's private
 * ID call count. The fallback keeps operations that eagerly mint a second ID
 * deterministic even when their first compare-and-set loses.
 */
function storeWithFirstId(raw: SqlExecutor, firstId: string): LibsqlSchedulerStore {
  let ids = 0
  let tokens = 0
  const source: IdSource = {
    uuidv7: () => (ids++ === 0 ? firstId : `${firstId}-fallback-${ids}`),
    token: () => `collision-token-${++tokens}`,
  }
  return new LibsqlSchedulerStore(raw, source)
}

/** All epoch-ms columns must hold INTEGER (or NULL) storage class. */
async function nonIntegerTemporalRows(raw: SqlExecutor): Promise<string[]> {
  const [result] = await raw.batch(
    't',
    [
      {
        sql: `SELECT 'runs/' || run_id AS v FROM runs
              WHERE typeof(available_at_ms) NOT IN ('integer','null')
                 OR typeof(claim_expires_at_ms) NOT IN ('integer','null')
                 OR typeof(heartbeat_at_ms) NOT IN ('integer','null')
                 OR typeof(created_at_ms) NOT IN ('integer','null')
              UNION ALL
              SELECT 'tasks/' || task_id FROM tasks
              WHERE typeof(enqueue_at_ms) NOT IN ('integer','null')
                 OR typeof(cancel_at_ms) NOT IN ('integer','null')`,
        args: [],
      },
    ],
    'read',
  )
  return (result?.rows ?? []).map((r) => String(r.v))
}

async function addLowerLiveSibling(
  raw: SqlExecutor,
  taskId: string,
  claimedRunId: string,
): Promise<void> {
  await raw.batch('forge-lower-live-sibling', [
    {
      sql: `UPDATE runs SET attempt = 2 WHERE run_id = ?`,
      args: [claimedRunId],
    },
    {
      sql: `UPDATE tasks SET attempts = 1 WHERE task_id = ?`,
      args: [taskId],
    },
    {
      sql: `INSERT INTO runs
              (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
            VALUES ('corrupt-sibling', ?, ?, 1, 'pending', 1060000, 1000000)`,
      args: [Q, taskId],
    },
  ])
}

async function withInheritedRelativeWake<T>(action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'inSeconds')
  Object.defineProperty(Object.prototype, 'inSeconds', {
    configurable: true,
    value: 0,
    writable: true,
  })
  try {
    return await action()
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, 'inSeconds')
    else Object.defineProperty(Object.prototype, 'inSeconds', descriptor)
  }
}

/**
 * Red/green regression case law (repo rule: every
 * bug lands as a red-test commit first, then the fix commit). Each test
 * FAILED against the pre-fix sweep implementation; the finding it pins is
 * named in the test title.
 */

describe('transition-layer review regressions (second round)', () => {
  it('non-finite and unsafe numeric inputs are refused at the port boundary', async () => {
    const f = await makeLibsqlFixture('numeric-gate')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await expect(
      f.store.spawn(Q, 'j', '{}', { startDelaySeconds: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(RangeError)
    await expect(f.store.spawn(Q, 'j', '{}', { maxAttempts: 0 })).rejects.toThrow(RangeError)
    await expect(f.store.spawn(Q, 'j', '{}', { maxAttempts: 2.5 })).rejects.toThrow(RangeError)
    await expect(
      f.store.spawn(Q, 'j', '{}', { cancellation: { maxDelaySeconds: Number.NaN } }),
    ).rejects.toThrow(RangeError)
    // Nothing above may have written anything.
    const [none] = await f.raw.batch('t', [{ sql: `SELECT COUNT(*) AS n FROM tasks`, args: [] }])
    expect(Number(none?.rows[0]?.n)).toBe(0)

    await f.store.spawn(Q, 'job', '{}')
    // Number.MAX_VALUE * 1000 stores SQLite Inf: an unexpirable lease.
    await expect(
      f.store.claim(Q, 'w-bad', { leaseSeconds: Number.MAX_VALUE, limit: 1 }),
    ).rejects.toThrow(RangeError)
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await expect(
      f.store.heartbeat(Q, run.runId, run.claimToken, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(RangeError)
    await expect(
      f.store.reschedule(Q, run.runId, run.claimToken, { atEpochMs: 2 ** 53 }),
    ).rejects.toThrow(RangeError)
    await expect(
      f.store.fail(Q, run.runId, run.claimToken, '{"name":"B"}', { delaySeconds: -5 }),
    ).rejects.toThrow(RangeError)
    // The rejected calls fenced nothing: the lease is intact and usable.
    await f.store.complete(Q, run.runId, run.claimToken, '{"ok":1}')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('temporal columns keep INTEGER storage class under fractional-second inputs', async () => {
    const f = await makeLibsqlFixture('storage-class')
    await f.admin.setFakeNowEpochMs(1_000_000)
    // Sub-millisecond fractions everywhere a duration crosses the port:
    // JS numbers bind as REAL, and INTEGER columns are affinity, not law.
    await f.store.spawn(Q, 'job', '{}', {
      startDelaySeconds: 0.0004,
      cancellation: { maxDelaySeconds: 120.5005 },
    })
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60.6004, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 's', '{}', 90.7009)
    await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 1.0007 })
    expect(await nonIntegerTemporalRows(f.raw)).toEqual([])
    await f.close()
  })

  it('reschedule classifies an absolute wake by its own discriminant', async () => {
    const f = await makeLibsqlFixture('absolute-reschedule-own-discriminant')
    try {
      await f.admin.setFakeNowEpochMs(1_000_000)
      await f.store.spawn(Q, 'job', '{}')
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('claim')
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await withInheritedRelativeWake(() =>
        f.store.reschedule(Q, run.runId, run.claimToken, { atEpochMs: 1_030_000 }),
      )
      const [stored] = await f.raw.batch(
        'absolute-reschedule-result',
        [
          {
            sql: `SELECT available_at_ms FROM runs WHERE run_id = ?`,
            args: [run.runId],
          },
        ],
        'read',
      )
      expect(
        stored?.rows[0]?.available_at_ms,
        'mutation-verdict:behavior:reschedule-wake-own-discriminant',
      ).toBe(1_030_000)
    } finally {
      await f.close()
    }
  })

  it('suspendRun keeps an absolute wake aligned with its marker', async () => {
    const f = await makeLibsqlFixture('absolute-suspend-own-discriminant')
    try {
      await f.admin.setFakeNowEpochMs(1_000_000)
      await f.store.spawn(Q, 'job', '{}')
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('claim')
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await withInheritedRelativeWake(() =>
        f.store.suspendRun(
          Q,
          run.runId,
          run.claimToken,
          { atEpochMs: 1_030_000 },
          { key: '$sleepUntil', stateJson: '{"atEpochMs":1030000}' },
        ),
      )
      const [stored, marker] = await f.raw.batch(
        'absolute-suspend-result',
        [
          {
            sql: `SELECT available_at_ms FROM runs WHERE run_id = ?`,
            args: [run.runId],
          },
          {
            sql: `SELECT state FROM checkpoints
                  WHERE task_id = ? AND checkpoint_name = '$sleepUntil'`,
            args: [run.taskId],
          },
        ],
        'read',
      )
      expect(
        {
          availableAtMs: stored?.rows[0]?.available_at_ms,
          marker: marker?.rows[0]?.state,
        },
        'mutation-verdict:behavior:suspend-wake-own-discriminant',
      ).toEqual({ availableAtMs: 1_030_000, marker: '{"atEpochMs":1030000}' })
    } finally {
      await f.close()
    }
  })

  it('fail() at the cap under a successor-id collision books nothing foreign', async () => {
    const f = await makeLibsqlFixture('fail-collide')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    expect(run.taskId).toBe(spawned.taskId)
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)

    const predictedSuccessor = 'foreign-fail-successor'
    // A FOREIGN pending run under a live foreign task at exactly that id.
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
                max_attempts, enqueue_at_ms, created_at_ms, state)
              VALUES ('foreign-task', ?, 'x', '{}', '{"kind":"none"}', 1, 1000000, 1000000, 'pending')`,
        args: [Q],
      },
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
              VALUES (?, ?, 'foreign-task', 1, 'pending', 1000000, 1000000)`,
        args: [predictedSuccessor, Q],
      },
    ])
    // At the cap the successor INSERT is suppressed (0 rows, no PK error) —
    // the follow-ons must NOT mistake the pre-existing foreign row for it.
    await storeWithFirstId(f.raw, predictedSuccessor).fail(
      Q,
      run.runId,
      run.claimToken,
      '{"name":"Boom"}',
      { delaySeconds: 0 },
    )
    const [task] = await f.raw.batch('t', [
      {
        sql: `SELECT state, attempts, last_attempt_run FROM tasks WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    expect(task?.rows[0]).toMatchObject({ state: 'failed', attempts: 1 })
    expect(task?.rows[0]?.last_attempt_run).not.toBe(predictedSuccessor)
    const [foreign] = await f.raw.batch('t', [
      { sql: `SELECT state, task_id FROM runs WHERE run_id = ?`, args: [predictedSuccessor] },
    ])
    expect(foreign?.rows[0]).toMatchObject({ state: 'pending', task_id: 'foreign-task' })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('complete() under a (corrupt) terminal task leaves the task state alone', async () => {
    const f = await makeLibsqlFixture('terminal-complete')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.raw.batch('t', [
      {
        sql: `UPDATE tasks SET state = 'cancelled', cancelled_at_ms = 1000000,
                failure_reason = '{"name":"$Cancelled"}'
              WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    // The run may finish (its fence is valid) but TerminalStability owns the
    // task: cancelled must never become completed.
    await f.store.complete(Q, run.runId, run.claimToken, '{"ok":1}').catch(() => {})
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]?.state).toBe('cancelled')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('reschedule() under a (corrupt) terminal task refuses instead of reviving it', async () => {
    const f = await makeLibsqlFixture('terminal-reschedule')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.raw.batch('t', [
      {
        sql: `UPDATE tasks SET state = 'cancelled', cancelled_at_ms = 1000000,
                failure_reason = '{"name":"$Cancelled"}'
              WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    // Suspending would mint a LIVE sleeping run under a terminal task —
    // the transition must refuse wholesale (AB002), not half-apply.
    await expect(
      f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 10 }),
    ).rejects.toThrow(LeaseLostError)
    const [taskRow, runRow] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
      { sql: `SELECT state, claimed_by FROM runs WHERE run_id = ?`, args: [run.runId] },
    ])
    expect(taskRow?.rows[0]?.state).toBe('cancelled')
    expect(runRow?.rows[0]).toMatchObject({ state: 'running', claimed_by: run.claimToken })
    await f.close()
  })

  it('a launch deferral keeps a carried event wake for the next claimer', async () => {
    const f = await makeLibsqlFixture('wake-preserve')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    // A carried wake arrives with the claim (as the event emit will park it).
    await f.raw.batch('t', [
      {
        sql: `UPDATE runs SET wake_event = 'e1', event_payload = '{"x":1}', wake_step = '$await:e1' WHERE run_id = ?`,
        args: [run.runId],
      },
    ])
    // §3.2 deferral: a worker that cannot dispatch this task defers before
    // activation WITHOUT consuming anything; the wake survives for a capable claimer.
    await f.store.deferLaunch(Q, run.runId, run.claimToken, run.claimGen, 1)
    await f.admin.setFakeNowEpochMs(1_001_000)
    const [again] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    expect(again?.runId).toBe(run.runId)
    expect(again?.wake).toMatchObject({ payloadJson: '{"x":1}' })
    await f.close()
  })

  it('spawn under an id collision with a terminal task creates no run (rule 6)', async () => {
    // Codex PR#11 round 6: the initial-run INSERT selected a bare task_id
    // even when the task insert lost (idempotency conflict). With an injected
    // uuid colliding an existing TERMINAL task, a pending run was booked under
    // it. Force spawn's first id and pre-seed that state.
    const f = await makeLibsqlFixture('spawn-collide')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const collidingId = 'terminal-task-collision'
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
                idempotency_key, state, enqueue_at_ms, created_at_ms)
              VALUES (?, ?, 'x', '{}', '{"kind":"none"}', 1, 'k', 'completed', 1000000, 1000000)`,
        args: [collidingId, Q],
      },
    ])
    // Deliberately NOT wrapped in .catch(): a colliding task id must make the
    // insert LOSE, the same as any other conflict, not raise a constraint
    // error out of spawn. Swallowing the rejection here made this test pass
    // either way, so deleting the guard that converts the collision into a
    // lost compare-and-set broke nothing — found by mutation probe.
    const result = await storeWithFirstId(f.raw, collidingId).spawn(Q, 'job', '{}', {
      idempotencyKey: 'k',
    })
    expect(result.created).toBe(false)
    const [runs] = await f.raw.batch('t', [
      { sql: `SELECT COUNT(*) AS n FROM runs WHERE task_id = ?`, args: [collidingId] },
    ])
    expect(Number(runs?.rows[0]?.n)).toBe(0) // no run under the terminal task
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [collidingId] },
    ])
    expect(task?.rows[0]?.state).toBe('completed')
    await f.close()
  })

  it('spawn loses rather than crashing when only the task id collides', async () => {
    // The case above collides on BOTH the task id and the idempotency key, so
    // the targeted ON CONFLICT absorbs it and the primary-key guard is never
    // needed — which is why deleting that guard broke nothing. The guard
    // exists for a collision on the id ALONE, where the targeted conflict
    // clause does not apply and the insert would raise a constraint error out
    // of spawn to a caller who did nothing wrong.
    const f = await makeLibsqlFixture('spawn-collide-id-only')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const collidingId = 'task-id-only-collision'
    await f.raw.batch('t', [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
                state, enqueue_at_ms, created_at_ms)
              VALUES (?, ?, 'other', '{}', '{"kind":"none"}', 1, 'pending', 1000000, 1000000)`,
        args: [collidingId, Q],
      },
    ])

    const result = await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'spawn-primary-key-guard' },
      /UNIQUE constraint failed: tasks\.task_id/,
      () => storeWithFirstId(f.raw, collidingId).spawn(Q, 'job', '{}'), // no idempotency key
    )
    expect(result).toMatchObject({ created: false })

    // The pre-existing task is untouched: no run was attached to it, and its
    // name is still its own.
    const [rows] = await f.raw.batch('t', [
      {
        sql: `SELECT (SELECT COUNT(*) FROM runs WHERE task_id = t.task_id) AS runs,
                     t.task_name
              FROM tasks t WHERE t.task_id = ?`,
        args: [collidingId],
      },
    ])
    expect(rows?.rows[0]).toMatchObject({ runs: 0, task_name: 'other' })
    await f.close()
  })

  it('a same-token claim receipt never revives a terminal task (rule 6)', async () => {
    // Codex PR#11 round 5: a completed task whose run still carries token T
    // (the externally-corrupted state rule 6 covers). A same-token claim(T)
    // must not revive the task to 'running' nor hand the run back to launch.
    const f = await makeLibsqlFixture('terminal-claim-receipt')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'T', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.raw.batch('t', [
      {
        sql: `UPDATE tasks SET state = 'completed', completed_payload = '{}' WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    const again = await f.store.claim(Q, 'T', { leaseSeconds: 60, limit: 1 })
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]?.state).toBe('completed') // not revived
    expect(again).toHaveLength(0) // no terminal run handed back
    await f.close()
  })

  it('a same-token claim receipt refuses a task with multiple live runs', async () => {
    const f = await makeLibsqlFixture('multiple-live-claim-receipt')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'T', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await addLowerLiveSibling(f.raw, spawned.taskId, run.runId)

    const receipt = await f.store.claim(Q, 'T', { leaseSeconds: 60, limit: 1 })
    expect(receipt, 'mutation-verdict:behavior:claim-receipt-requires-sole-live-run').toHaveLength(
      0,
    )
    await f.close()
  })

  it('activate refuses a claim whose task acquired another live run', async () => {
    const f = await makeLibsqlFixture('multiple-live-activate')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'T', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await addLowerLiveSibling(f.raw, spawned.taskId, run.runId)

    const activated = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    expect(activated, 'mutation-verdict:behavior:activate-requires-sole-live-run').toBeNull()
    const [row] = await f.raw.batch('t', [
      {
        sql: `SELECT activated_gen, started_at_ms FROM runs WHERE run_id = ?`,
        args: [run.runId],
      },
    ])
    expect(row?.rows[0]).toMatchObject({ activated_gen: 0, started_at_ms: null })
    await f.close()
  })

  it('a losing duplicate activate never re-arms a terminal task deadline (rule 6)', async () => {
    // Codex PR#11 round 5: a duplicate activate loses the CAS (returns null)
    // but its follow-on matched the pre-existing activated state and re-armed
    // a completed task's cleared cancellation deadline.
    const f = await makeLibsqlFixture('terminal-activate-dup')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}', {
      cancellation: { maxDurationSeconds: 100 },
    })
    const [run] = await f.store.claim(Q, 'T', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.raw.batch('t', [
      {
        sql: `UPDATE tasks SET state = 'completed', cancel_at_ms = NULL WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).toBeNull()
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state, cancel_at_ms FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]?.state).toBe('completed')
    expect(task?.rows[0]?.cancel_at_ms).toBeNull() // deadline not re-armed
    await f.close()
  })
})

describe('transition-layer review regressions (first round)', () => {
  it('fail() refuses a successor past max_attempts: the task fails terminally at the cap', async () => {
    const f = await makeLibsqlFixture('cap-enforce')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 2 })
    // Attempt 1 fails with retry — allowed (attempt 2 fits the cap).
    let [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim 1')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })
    // Attempt 2 fails "with retry" — but the cap must refuse the successor.
    ;[run] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim 2')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    await f.store.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })
    const [runs] = await f.raw.batch('t', [
      { sql: `SELECT COUNT(*) AS n FROM runs WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(runs?.rows[0]?.n)).toBe(2) // no third run
    const [task] = await f.raw.batch('t', [
      { sql: `SELECT state, attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(task?.rows[0]).toMatchObject({ state: 'failed', attempts: 2 })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('setCheckpoint rejects a task_id that does not belong to the fencing run', async () => {
    const f = await makeLibsqlFixture('ckpt-scope')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'a', '{}')
    const other = await f.store.spawn(Q, 'b', '{}', { startDelaySeconds: 900 })
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    // Foreign task id under a valid lease: must throw and write NOTHING.
    await expect(
      f.store.setCheckpoint(Q, other.taskId, run.runId, run.claimToken, 's', '{"x":1}', 60),
    ).rejects.toThrow()
    const [rows] = await f.raw.batch('t', [
      { sql: `SELECT COUNT(*) AS n FROM checkpoints WHERE task_id = ?`, args: [other.taskId] },
    ])
    expect(Number(rows?.rows[0]?.n)).toBe(0)
    await f.close()
  })

  it('a consumed event wake is cleared by reschedule — timer wakes do not replay it', async () => {
    const f = await makeLibsqlFixture('wake-consume')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    let [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim 1')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    // Park a wake (as the event emit will), fail with retry so it carries.
    await f.raw.batch('t', [
      {
        sql: `UPDATE runs SET wake_event = 'e1', event_payload = '{"x":1}', wake_step = '$await:e1' WHERE run_id = ?`,
        args: [run.runId],
      },
    ])
    await f.store.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })
    // The successor's claim presents the carried wake — correct (§3.8.2)...
    ;[run] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim 2')
    expect(run.wake).toBeDefined()
    const activated = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    if (!activated) throw new Error('activate')
    // ...the worker processes it and sleeps. The wake is now CONSUMED.
    await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 10 })
    await f.admin.setFakeNowEpochMs(1_020_000)
    const [timerWake] = await f.store.claim(Q, 'w3', { leaseSeconds: 60, limit: 1 })
    expect(timerWake?.runId).toBe(run.runId)
    // A pure timer wake must NOT re-present the consumed event.
    expect(timerWake?.wake).toBeUndefined()
    await f.close()
  })

  it('fail() with retry under a terminal task creates no successor (sweep-site parity)', async () => {
    const f = await makeLibsqlFixture('terminal-successor')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    // Simulate a deferred/cross-plane teardown: the task is terminal while
    // the run row is still 'running' under a live token.
    await f.raw.batch('t', [
      {
        sql: `UPDATE tasks SET state = 'failed', failure_reason = '{"name":"External"}'
              WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    await f.store
      .fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })
      .catch(() => {})
    const [rows] = await f.raw.batch('t', [
      {
        sql: `SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state IN ('pending','sleeping')`,
        args: [spawned.taskId],
      },
    ])
    // No live successor may exist under a terminal task.
    expect(Number(rows?.rows[0]?.n)).toBe(0)
    await f.close()
  })
})

describe('sweep and cancellation review regressions', () => {
  it('losing sweeper can never terminally fail a task whose successor lives (stamp fencing)', async () => {
    const corruptSeeds: number[] = []
    for (let seed = 0; seed < 150; seed++) {
      const f = await makeLibsqlFixture(`race-${seed}`)
      await f.admin.setFakeNowEpochMs(1_000_000)
      const spawned = await f.store.spawn(Q, 'job', '{}')
      // The boundary the reviewed interleaving needs: one infra retry left.
      await f.raw.batch('t', [
        { sql: `UPDATE tasks SET infra_retries = 19 WHERE task_id = ?`, args: [spawned.taskId] },
        { sql: `UPDATE runs SET attempt = 20 WHERE task_id = ?`, args: [spawned.taskId] },
      ])
      await claimActivated(f.store, Q, 'w0')
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
      await f.close()
    }
    expect(corruptSeeds, 'seeds reaching an invariant-violating state').toEqual([])
  })

  // fenceTwin('CancelSweep') — the disarmed-deadline guard blocks the
  // sweep's cancel CAS from firing on a task that started in time.
  it('max_delay never cancels a task that started on time', async () => {
    const f = await makeLibsqlFixture('max-delay')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}', { cancellation: { maxDelaySeconds: 30 } })
    const run = await claimOne(f.store, Q, 't1', 600)
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
    await f.close()
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
    await f.close()
  })

  it("sweep-terminal transitions delete the dead run's waits (no orphan waits)", async () => {
    const f = await makeLibsqlFixture('waits')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const run = await claimActivated(f.store, Q, 't1')
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
    await f.close()
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
    await f.close()
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
    await f.close()
  })

  it('negative and zero sweep limits do nothing (SQLite LIMIT -1 is unlimited)', async () => {
    const f = await makeLibsqlFixture('neg-limit')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 1 })
    await f.admin.setFakeNowEpochMs(1_100_000)
    expect(await f.store.sweep(Q, -1)).toEqual([])
    expect(await f.store.sweep(Q, 0)).toEqual([])
    await f.close()
  })

  it('expireLeaseNow returns false for an already-expired lease', async () => {
    const f = await makeLibsqlFixture('expire')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    const run = await claimActivated(f.store, Q, 't1')
    await f.admin.setFakeNowEpochMs(1_100_000) // lease already past
    expect(
      await f.store.expireLeaseNow(Q, run.runId, run.claimToken),
      'mutation-verdict:behavior:expire-lease-requires-future-expiry',
    ).toBe(false)
    await f.close()
  })

  it('expireLeaseNow refuses to launder a fractional stored expiry', async () => {
    const f = await makeLibsqlFixture('expire-fractional')
    await f.admin.setFakeNowEpochMs(1_000_000)
    await f.store.spawn(Q, 'job', '{}')
    const run = await claimActivated(f.store, Q, 't1')
    await f.raw.batch('fractional-expiry', [
      {
        sql: `UPDATE runs SET claim_expires_at_ms = 1000000.5 WHERE run_id = ?`,
        args: [run.runId],
      },
    ])

    const expired = await f.store.expireLeaseNow(Q, run.runId, run.claimToken)
    const [state] = await f.raw.batch('fractional-expiry-state', [
      {
        sql: `SELECT claim_expires_at_ms, typeof(claim_expires_at_ms) AS storage_type
              FROM runs WHERE run_id = ?`,
        args: [run.runId],
      },
    ])
    expect(
      { expired, row: state?.rows[0] },
      'mutation-verdict:behavior:expire-lease-requires-integer-expiry',
    ).toEqual({
      expired: false,
      row: { claim_expires_at_ms: 1_000_000.5, storage_type: 'real' },
    })
    await f.close()
  })

  it('a successor-id collision fails loudly instead of booking a foreign run', async () => {
    const f = await makeLibsqlFixture('collide')
    await f.admin.setFakeNowEpochMs(1_000_000)
    const spawned = await f.store.spawn(Q, 'job', '{}')
    await claimActivated(f.store, Q, 'w0')

    const predictedSuccessor = 'foreign-sweep-successor'
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
    await f.admin.setFakeNowEpochMs(1_100_000)
    // The collision must surface loudly — never silent bookkeeping against
    // a foreign row.
    await expect(storeWithFirstId(f.raw, predictedSuccessor).sweep(Q, 10)).rejects.toThrow()
    const [task] = await f.raw.batch('t', [
      {
        sql: `SELECT infra_retries, last_attempt_run FROM tasks WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    expect(Number(task?.rows[0]?.infra_retries)).toBe(0)
    expect(task?.rows[0]?.last_attempt_run).not.toBe(predictedSuccessor)
    await f.close()
  })

  // fenceTwin('CancelExplicit') — the losing cancel CAS returns false and
  // its follow-ons touch nothing.
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
    await f.close()
  })
})

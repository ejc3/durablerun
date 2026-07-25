import { LeaseLostError, type SqlExecutor } from '@durablerun/core'
import { SimWorld } from '@durablerun/harness'
import { type LibsqlExecutor, LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'

/**
 * Provenance regressions: a batch statement firing without proof that THIS
 * batch produced the state it keys on.
 *
 * Each case drives a real store operation against a state a stale,
 * duplicated, id-colliding, or externally-corrupted caller can put the
 * database in, and asserts the operation does not amplify it. They are the
 * executable form of two contract rules (DESIGN.md section 3.4): a follow-on
 * keys on the winning write and never on state that could pre-exist (rule 1),
 * and terminal tasks are inert so even corrupt state is never amplified
 * (rule 6).
 *
 * State is built with raw SQL on purpose: the fences exist to make these
 * states unreachable through the public API, so writing them directly is the
 * only way to present them to a transition.
 */

const Q = 'q'
const NOW = 1_000_000
const RETRY_NONE = '{"kind":"none"}'

interface Fixture {
  raw: LibsqlExecutor
  store: LibsqlSchedulerStore
  storeOver: (db: SqlExecutor) => LibsqlSchedulerStore
  close: () => void
}

/**
 * Ids come from a caller-supplied list so a test can force the exact
 * collision it is about; anything past the list gets a unique spare.
 */
async function fixture(ids: string[] = [], tokens: string[] = []): Promise<Fixture> {
  const { raw } = await openTestDb({ nowMs: NOW })
  const idSource = () => {
    let nextId = 0
    let nextToken = 0
    return {
      uuidv7: () => ids[nextId++] ?? `spare-id-${nextId}`,
      token: () => tokens[nextToken++] ?? `spare-tok-${nextToken}`,
    }
  }
  return {
    raw,
    store: new LibsqlSchedulerStore(raw, idSource()),
    // A fresh id source per executor: a duplicated batch must replay the
    // SAME compiled statements, which is what the sim's duplicate injection
    // does below the store.
    storeOver: (db: SqlExecutor) => new LibsqlSchedulerStore(db, idSource()),
    close: () => raw.close(),
  }
}

async function exec(raw: LibsqlExecutor, sql: string, args: (string | number | null)[] = []) {
  await raw.batch('setup', [{ sql, args }], 'write')
}

async function query(
  raw: LibsqlExecutor,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<Record<string, unknown>[]> {
  const [rows] = await raw.batch('probe', [{ sql, args }], 'read')
  return (rows?.rows ?? []) as unknown as Record<string, unknown>[]
}

async function insertTask(
  raw: LibsqlExecutor,
  task: {
    id: string
    state: string
    attempts?: number
    infraRetries?: number
    maxAttempts?: number
    cancelAtMs?: number | null
    cancellation?: string | null
    idempotencyKey?: string | null
  },
) {
  await exec(
    raw,
    `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
       cancellation, idempotency_key, state, attempts, infra_retries,
       enqueue_at_ms, cancel_at_ms, created_at_ms)
     VALUES (?, ?, 'job', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      Q,
      RETRY_NONE,
      task.maxAttempts ?? 5,
      task.cancellation ?? null,
      task.idempotencyKey ?? null,
      task.state,
      task.attempts ?? 0,
      task.infraRetries ?? 0,
      NOW,
      task.cancelAtMs ?? null,
      NOW,
    ],
  )
}

async function insertRun(
  raw: LibsqlExecutor,
  run: {
    id: string
    taskId: string
    attempt?: number
    state: string
    claimedBy?: string | null
    claimGen?: number
    activatedGen?: number
    claimExpiresAtMs?: number | null
    availableAtMs?: number | null
  },
) {
  await exec(
    raw,
    `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by, claim_gen,
       activated_gen, lease_ms, claim_expires_at_ms, available_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 60000, ?, ?, ?)`,
    [
      run.id,
      Q,
      run.taskId,
      run.attempt ?? 1,
      run.state,
      run.claimedBy ?? null,
      run.claimGen ?? 1,
      run.activatedGen ?? 1,
      run.claimExpiresAtMs ?? null,
      run.availableAtMs ?? null,
      NOW,
    ],
  )
}

describe('fence provenance', () => {
  it('a replayed claim-timeout sweep at the infra cap leaves no live run under a terminal task', async () => {
    // The claim-timeout batch's terminal follow-on keys on "infra retries are
    // at the cap" plus the stamped dead run. On an exact replay of the same
    // compiled batch the successor insert is correctly suppressed (the cap is
    // now reached), but the terminal follow-on still matches — so the task
    // goes terminal while the successor run the first pass created is still
    // pending. That is precisely the state rule 6 forbids.
    const f = await fixture(['successor-1'], ['sweep-stamp'])
    // Legal state at the cap boundary: 19 infra retries means the live run is
    // attempt 20, because a run's attempt counts every successor.
    await insertTask(f.raw, { id: 'T', state: 'running', infraRetries: 19 })
    await insertRun(f.raw, {
      id: 'R',
      taskId: 'T',
      attempt: 20,
      state: 'running',
      claimedBy: 'worker',
      claimGen: 3,
      activatedGen: 3,
      claimExpiresAtMs: NOW - 1, // lease already expired
    })

    const world = new SimWorld(f.raw, 'sweep-cap-replay')
    world.injectDuplicate({ label: 'sweep:claim-timeout' })
    world.actor('sweeper', async (db) => {
      await f.storeOver(db).sweep(Q, 10)
    })
    await world.run()

    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a replayed claim-timeout sweep below the cap does not reject', async () => {
    // The successor insert is guarded on the dead run being failed and
    // carrying this batch's stamp — the state THIS batch's own compare-and-
    // swap just produced. Replaying the same compiled batch re-satisfies that
    // guard with the first pass's own write, so the insert runs a second time
    // with the same successor id and the same attempt ordinal and violates the
    // unique index. The batch is atomic so nothing is corrupted, but the CALL
    // rejects — and the driver awaits sweep bare at the top of a tick, so one
    // duplicated sweep item throws away the whole tick: no claims, no
    // launches, no next-wake calculation.
    //
    // The at-cap case (further down) hides this: there the second insert is
    // correctly refused because the cap has been reached.
    const f = await fixture(['successor-1'], ['sweep-stamp'])
    await insertTask(f.raw, { id: 'T', state: 'running', infraRetries: 0 })
    await insertRun(f.raw, {
      id: 'R',
      taskId: 'T',
      attempt: 1,
      state: 'running',
      claimedBy: 'worker',
      claimGen: 1,
      activatedGen: 1,
      claimExpiresAtMs: NOW - 1,
    })

    const world = new SimWorld(f.raw, 'sweep-below-cap-replay')
    world.injectDuplicate({ label: 'sweep:claim-timeout' })
    let rejection: unknown = null
    world.actor('sweeper', async (db) => {
      await f
        .storeOver(db)
        .sweep(Q, 10)
        .catch((e) => {
          rejection = e
        })
    })
    await world.run()

    expect(rejection).toBeNull()
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a replayed retrying failure does not reject', async () => {
    // The same shape in `fail`: the retry successor is guarded on the failing
    // run carrying this batch's stamp, which the batch itself wrote, so an
    // exact replay inserts the same successor id at the same attempt ordinal
    // a second time and the call rejects.
    const f = await fixture(['successor-1'], ['fail-stamp'])
    await insertTask(f.raw, { id: 'T', state: 'running', attempts: 0, maxAttempts: 5 })
    await insertRun(f.raw, {
      id: 'R',
      taskId: 'T',
      attempt: 1,
      state: 'running',
      claimedBy: 'worker',
      claimExpiresAtMs: NOW + 60_000,
    })

    const world = new SimWorld(f.raw, 'fail-retry-replay')
    world.injectDuplicate({ label: 'fail' })
    let rejection: unknown = null
    world.actor('worker', async (db) => {
      await f
        .storeOver(db)
        .fail(Q, 'R', 'worker', '{"name":"Boom"}', { delaySeconds: 0 })
        // Losing the fence on the duplicate is the documented contract; a
        // constraint violation from the store is not.
        .catch((e) => {
          if (!(e instanceof LeaseLostError)) rejection = e
        })
    })
    await world.run()

    expect(rejection).toBeNull()
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a failing run whose successor id collides with its own id still records the failure reason', async () => {
    // The two task follow-ons of `fail` discriminate on "does a run with the
    // successor id carry this batch's stamp". When the minted successor id
    // collides with the FAILING run's id, the stamped parent answers yes: the
    // retry arm fires even though the attempt cap refused the successor, and
    // the terminal arm — the only writer of the task's failure reason — is
    // skipped, so the task ends failed with no reason recorded.
    const f = await fixture(['R'], ['fail-stamp']) // successor id == parent id
    await insertTask(f.raw, { id: 'T', state: 'running', attempts: 1, maxAttempts: 2 })
    await insertRun(f.raw, {
      id: 'R',
      taskId: 'T',
      attempt: 2,
      state: 'running',
      claimedBy: 'worker',
      claimExpiresAtMs: NOW + 60_000,
    })

    await f.store.fail(Q, 'R', 'worker', '{"name":"Boom"}', { delaySeconds: 0 })

    const [task] = await query(f.raw, `SELECT state, failure_reason FROM tasks WHERE task_id = 'T'`)
    expect({ state: task?.state, reason: task?.failure_reason }).toEqual({
      state: 'failed',
      reason: '{"name":"Boom"}',
    })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('an activate that loses its generation check does not disarm the cancellation deadline', async () => {
    // The task follow-on of `activate` keys on the run's claim token plus its
    // activated generation, which a LOSING delivery also matches: after a
    // claim leaves generation 1 claimed and 0 activated, a delivery carrying
    // the stale generation 0 fails the compare-and-swap (activate returns
    // null) yet its follow-on still matches the un-activated run and rewrites
    // the task's cancellation deadline — clearing an armed start deadline, so
    // the sweep never cancels a task that was never started.
    const f = await fixture()
    await insertTask(f.raw, {
      id: 'T',
      state: 'running',
      cancelAtMs: NOW + 30_000, // armed start deadline; no max-duration clause
      cancellation: '{"maxDelaySeconds":30}',
    })
    await insertRun(f.raw, {
      id: 'R',
      taskId: 'T',
      state: 'running',
      claimedBy: 'worker',
      claimGen: 1,
      activatedGen: 0,
      claimExpiresAtMs: NOW + 60_000,
    })

    expect(await f.store.activate(Q, 'R', 'worker', 0)).toBeNull() // correctly refused

    const [task] = await query(f.raw, `SELECT cancel_at_ms FROM tasks WHERE task_id = 'T'`)
    expect(task?.cancel_at_ms).toBe(NOW + 30_000) // deadline untouched
    f.close()
  })

  it('spawn never reports a run id that does not exist', async () => {
    // spawn resolves its answer with a read that cannot tell "the run I just
    // inserted" from "whatever run this task already had" — and when the
    // winning task has NO run, it falls back to the id it minted but never
    // inserted. An idempotency hit against a task whose run is gone (swept,
    // or a half-built task) therefore hands the caller a run id that does not
    // exist, and every poll on it reports nothing forever.
    //
    // The contract asserted here: a reported run id NAMES A REAL RUN OF THE
    // REPORTED TASK. Null is allowed and is the honest answer when the
    // winning task has no run — spawn's job is to create a task or report
    // that one already exists, not to repair somebody else's. Giving the
    // runless winner a run was the other candidate repair and is deliberately
    // not taken: against a terminal task at a colliding id it would be
    // exactly the amplification rule 6 forbids.
    const f = await fixture(['NEW-TASK', 'NEW-RUN'])
    await insertTask(f.raw, { id: 'OLD-TASK', state: 'pending', idempotencyKey: 'key' })
    // Deliberately no run for OLD-TASK.

    const result = await f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'key' })

    expect({ created: result.created, taskId: result.taskId }).toEqual({
      created: false,
      taskId: 'OLD-TASK',
    })
    expect(result.runId).toBeNull()

    // And when the winner DOES have a run, that run is what comes back —
    // never the id this call minted and never inserted.
    await insertRun(f.raw, { id: 'OLD-RUN', taskId: 'OLD-TASK', state: 'pending' })
    const again = await f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'key' })
    expect({ created: again.created, runId: again.runId }).toEqual({
      created: false,
      runId: 'OLD-RUN',
    })
    f.close()
  })

  it('spawn resolves to the idempotency winner when a task id ALSO collides', async () => {
    // Both conflicts at once: the id spawn is about to mint already belongs to
    // a live task X, and a different task Y is the real winner for the
    // idempotency key. The insert loses on both, so the answer has to come
    // from a read — and that read must prefer the key's winner. Reporting X
    // instead hands the caller a task with a different name and parameters,
    // and a later claim runs THAT work believing it was asked for.
    //
    // The ordering is also the reason this is not `ORDER BY (t.task_id = ?)
    // DESC`, which is what it used to be: Postgres sorts NULLs first, so that
    // shape is not deterministic across dialects.
    const f = await fixture(['X', 'NEW-RUN'])
    await insertTask(f.raw, { id: 'X', state: 'pending' }) // collides, no key
    await insertTask(f.raw, { id: 'Y', state: 'pending', idempotencyKey: 'key' })
    await insertRun(f.raw, { id: 'rY', taskId: 'Y', state: 'pending' })

    const result = await f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'key' })

    expect({ created: result.created, taskId: result.taskId, runId: result.runId }).toEqual({
      created: false,
      taskId: 'Y',
      runId: 'rY',
    })
    // ...and nothing was attached to the task whose id merely collided.
    const runsOfX = await query(f.raw, `SELECT run_id FROM runs WHERE task_id = 'X'`)
    expect(runsOfX).toEqual([])
    f.close()
  })

  it('awaitEvent does not park on a wait row it did not register', async () => {
    // The wait insert does nothing on a conflicting (run, step) key, so a
    // pre-existing wait for the SAME run, step and event makes registration
    // lose silently. The park then keys on "a waiting wait for this event
    // exists" and borrows the stale row, inheriting ITS timeout instead of
    // the one this call asked for: an old untimed wait plus a new 30-second
    // await parks the run forever.
    const f = await fixture([], ['park-stamp'])
    await insertTask(f.raw, { id: 'T', state: 'running' })
    await insertRun(f.raw, {
      id: 'R',
      taskId: 'T',
      state: 'running',
      claimedBy: 'worker',
      claimExpiresAtMs: NOW + 60_000,
    })
    // Stale untimed wait left at the same step by an earlier attempt.
    await exec(
      f.raw,
      `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
         timeout_at_ms, created_at_ms)
       VALUES ('R', '$await:go', ?, 'T', 'go', 'waiting', NULL, ?)`,
      [Q, NOW - 999],
    )

    let refusal: unknown = null
    await f.store
      .awaitEvent(Q, 'T', 'R', 'worker', '$await:go', 'go', 30)
      .catch((error: unknown) => {
        refusal = error
      })

    const [run] = await query(f.raw, `SELECT state, available_at_ms FROM runs WHERE run_id = 'R'`)
    if (refusal !== null) {
      expect(refusal).toBeInstanceOf(LeaseLostError)
      expect(run).toMatchObject({ state: 'running', available_at_ms: null })
    } else {
      // Parked under ITS OWN 30-second deadline, never the stale row's NULL.
      expect(run?.available_at_ms).toBe(NOW + 30_000)
    }
    f.close()
  })

  it('emitEvent does not wake a task that a corrupt wait row merely names', async () => {
    // The task fan-out reads task ids straight out of the waits table rather
    // than from the runs this batch actually woke. A corrupt wait row (task
    // A's run, naming healthy task B) flips B to pending while B's own run
    // keeps running — corrupt state amplified into a healthy task.
    const f = await fixture()
    await insertTask(f.raw, { id: 'A', state: 'sleeping' })
    await insertRun(f.raw, { id: 'rA', taskId: 'A', state: 'sleeping' })
    await insertTask(f.raw, { id: 'B', state: 'running' })
    await insertRun(f.raw, {
      id: 'rB',
      taskId: 'B',
      state: 'running',
      claimedBy: 'worker',
      claimExpiresAtMs: NOW + 60_000,
    })
    // Corrupt: the wait belongs to run rA but names task B.
    await exec(
      f.raw,
      `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
       VALUES ('rA', '$await:go', ?, 'B', 'go', 'waiting', ?)`,
      [Q, NOW],
    )

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [taskB] = await query(f.raw, `SELECT state FROM tasks WHERE task_id = 'B'`)
    expect(taskB?.state).toBe('running') // B was never waiting; it must not move
    f.close()
  })
})

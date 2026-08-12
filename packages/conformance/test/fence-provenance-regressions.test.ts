import {
  FENCE_SET,
  FencedBatch,
  INFRA_RETRY_CAP,
  LeaseLostError,
  MAX_COUNT,
  MAX_RUN_ORDINAL,
  REASON_CLAIM_TIMEOUT,
  RELAUNCH_CAP,
  type SqlExecutor,
} from '@durablerun/core'
import { SimWorld } from '@durablerun/harness'
import { type LibsqlExecutor, LibsqlSchedulerStore, NOW_MS } from '@durablerun/store-libsql'
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

function recorder(raw: LibsqlExecutor) {
  const seen: { label: string; statements: { sql: string; args: unknown[] }[] }[] = []
  const db: SqlExecutor = {
    batch: (label, statements, mode) => {
      seen.push({
        label,
        statements: statements.map((statement) => ({
          sql: statement.sql,
          args: [...statement.args],
        })),
      })
      return raw.batch(label, statements, mode)
    },
  }
  return {
    db,
    replay: (label: string) => {
      const call = seen.find((candidate) => candidate.label === label)
      if (!call) throw new Error(`no batch labelled ${label} was recorded`)
      return raw.batch(label, call.statements as { sql: string; args: never[] }[], 'write')
    },
  }
}

function restoreOwnProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor !== undefined) {
    Object.defineProperty(target, key, descriptor)
    return
  }
  if (!Reflect.deleteProperty(target, key)) {
    throw new Error(`could not restore ${String(key)}`)
  }
}

async function taskRunProgress(raw: LibsqlExecutor, taskId: string) {
  const [task] = await query(
    raw,
    `SELECT state, attempts, infra_retries, failure_reason
     FROM tasks WHERE task_id = ?`,
    [taskId],
  )
  const runs = await query(
    raw,
    `SELECT run_id, attempt, state, claimed_by, failure_reason
     FROM runs WHERE task_id = ? ORDER BY attempt, run_id`,
    [taskId],
  )
  return {
    task: {
      state: task?.state,
      attempts: Number(task?.attempts),
      infraRetries: Number(task?.infra_retries),
      failureReason: task?.failure_reason,
    },
    runs: runs.map((run) => ({
      runId: run.run_id,
      attempt: Number(run.attempt),
      state: run.state,
      claimedBy: run.claimed_by,
      failureReason: run.failure_reason,
    })),
  }
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
    queue?: string
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
      task.queue ?? Q,
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
    queue?: string
  },
) {
  await exec(
    raw,
    `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by, claim_gen,
       activated_gen, lease_ms, claim_expires_at_ms, available_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 60000, ?, ?, ?)`,
    [
      run.id,
      run.queue ?? Q,
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

/**
 * Build attempt two entirely through the public protocol, then revive only
 * its failed predecessor. This is the smallest reachable history that puts a
 * lower live sibling beside the currently owned run.
 */
async function currentAttemptWithRevivedPredecessor(
  f: Fixture,
  activateCurrent: boolean,
): Promise<{ taskId: string; currentRunId: string; currentClaimToken: string }> {
  const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
  const [first] = await f.store.claim(Q, 'first-worker', { leaseSeconds: 60, limit: 1 })
  if (!first) throw new Error('expected first claim')
  if (!(await f.store.activate(Q, first.runId, first.claimToken, first.claimGen))) {
    throw new Error('expected first activation')
  }
  await f.store.fail(Q, first.runId, first.claimToken, '{"name":"retry"}', {
    delaySeconds: 0,
  })

  const [current] = await f.store.claim(Q, 'current-worker', { leaseSeconds: 60, limit: 1 })
  if (!current) throw new Error('expected successor claim')
  if (
    activateCurrent &&
    !(await f.store.activate(Q, current.runId, current.claimToken, current.claimGen))
  ) {
    throw new Error('expected successor activation')
  }

  await exec(f.raw, `UPDATE runs SET state = 'pending' WHERE run_id = ?`, [first.runId])
  return {
    taskId: spawned.taskId,
    currentRunId: current.runId,
    currentClaimToken: current.claimToken,
  }
}

async function taskRunSnapshot(raw: LibsqlExecutor, taskId: string): Promise<unknown> {
  return {
    task: await query(raw, `SELECT * FROM tasks WHERE task_id = ?`, [taskId]),
    runs: await query(raw, `SELECT * FROM runs WHERE task_id = ? ORDER BY attempt, run_id`, [
      taskId,
    ]),
  }
}

async function activatedRun(f: Fixture): Promise<{
  taskId: string
  runId: string
  claimToken: string
}> {
  const spawned = await f.store.spawn(Q, 'job', '{}')
  const [run] = await f.store.claim(Q, 'worker', { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('expected claimed run')
  if (!(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen))) {
    throw new Error('expected activated run')
  }
  return { taskId: spawned.taskId, runId: run.runId, claimToken: run.claimToken }
}

async function moveTaskToOtherQueue(f: Fixture, taskId: string): Promise<void> {
  await exec(f.raw, `UPDATE tasks SET queue = 'other' WHERE task_id = ?`, [taskId])
}

describe('fence provenance', () => {
  it('complete does not make a task terminal while a lower live sibling remains', async () => {
    const f = await fixture()
    try {
      const current = await currentAttemptWithRevivedPredecessor(f, true)
      const before = await taskRunSnapshot(f.raw, current.taskId)

      const outcome = await f.store
        .complete(Q, current.currentRunId, current.currentClaimToken, '{"ok":true}')
        .then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        )

      expect(
        { outcome, after: await taskRunSnapshot(f.raw, current.taskId) },
        'mutation-verdict:behavior:complete-terminalization-requires-sole-live-run',
      ).toEqual({ outcome: 'rejected', after: before })
    } finally {
      f.close()
    }
  })

  it('non-retrying fail does not make a task terminal while a lower live sibling remains', async () => {
    const f = await fixture()
    try {
      const current = await currentAttemptWithRevivedPredecessor(f, true)
      const before = await taskRunSnapshot(f.raw, current.taskId)

      const outcome = await f.store
        .fail(Q, current.currentRunId, current.currentClaimToken, '{"name":"terminal"}', null)
        .then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        )

      expect(
        { outcome, after: await taskRunSnapshot(f.raw, current.taskId) },
        'mutation-verdict:behavior:fail-terminalization-requires-sole-live-run',
      ).toEqual({ outcome: 'rejected', after: before })
    } finally {
      f.close()
    }
  })

  it('relaunch-cap sweep does not make a task terminal while a lower live sibling remains', async () => {
    const f = await fixture()
    try {
      const current = await currentAttemptWithRevivedPredecessor(f, false)
      await exec(f.raw, `UPDATE runs SET relaunch_count = ? WHERE run_id = ?`, [
        RELAUNCH_CAP,
        current.currentRunId,
      ])
      await exec(f.raw, `UPDATE meta SET value = ? WHERE key = 'fake_now_ms'`, [
        String(NOW + 60_001),
      ])
      const before = await taskRunSnapshot(f.raw, current.taskId)

      const swept = await f.store.sweep(Q, 10)

      expect(
        { swept, after: await taskRunSnapshot(f.raw, current.taskId) },
        'mutation-verdict:behavior:relaunch-cap-terminalization-requires-sole-live-run',
      ).toEqual({ swept: [], after: before })
    } finally {
      f.close()
    }
  })

  it('a replayed claim-timeout sweep at the infra cap leaves no live run under a terminal task', async () => {
    // The claim-timeout batch's terminal follow-on keys on "infra retries are
    // at the cap" plus the stamped dead run. On an exact replay of the same
    // compiled batch the successor insert is correctly suppressed (the cap is
    // now reached), but the terminal follow-on still matches — so the task
    // goes terminal while the successor run the first pass created is still
    // pending. That is precisely the state rule 6 forbids.
    const f = await fixture(['successor-1'], ['sweep-stamp'])
    // Legal state at the cap boundary: cap-1 infra retries means the live run
    // is attempt cap, because a run's attempt counts every successor.
    await insertTask(f.raw, {
      id: 'T',
      state: 'running',
      infraRetries: INFRA_RETRY_CAP - 1,
    })
    await insertRun(f.raw, {
      id: 'prov-sweep-run',
      taskId: 'T',
      attempt: INFRA_RETRY_CAP,
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

    expect(
      await taskRunProgress(f.raw, 'T'),
      'mutation-verdict:behavior:provenance-sweep-progress',
    ).toEqual({
      task: {
        state: 'pending',
        attempts: 0,
        infraRetries: INFRA_RETRY_CAP,
        failureReason: null,
      },
      runs: [
        {
          runId: 'prov-sweep-run',
          attempt: INFRA_RETRY_CAP,
          state: 'failed',
          claimedBy: null,
          failureReason: REASON_CLAIM_TIMEOUT,
        },
        {
          runId: 'successor-1',
          attempt: INFRA_RETRY_CAP + 1,
          state: 'pending',
          claimedBy: null,
          failureReason: null,
        },
      ],
    })
    expect(
      await engineInvariantViolations(f.raw),
      'mutation-verdict:behavior:provenance-sweep-progress',
    ).toEqual([])
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
      id: 'prov-sweep-run',
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

    expect(rejection, 'mutation-verdict:behavior:provenance-sweep-progress').toBeNull()
    expect(
      await taskRunProgress(f.raw, 'T'),
      'mutation-verdict:behavior:provenance-sweep-progress',
    ).toEqual({
      task: {
        state: 'pending',
        attempts: 0,
        infraRetries: 1,
        failureReason: null,
      },
      runs: [
        {
          runId: 'prov-sweep-run',
          attempt: 1,
          state: 'failed',
          claimedBy: null,
          failureReason: REASON_CLAIM_TIMEOUT,
        },
        {
          runId: 'successor-1',
          attempt: 2,
          state: 'pending',
          claimedBy: null,
          failureReason: null,
        },
      ],
    })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  async function immediateRetryFailureReplay() {
    const f = await fixture(['successor-1'], ['fail-stamp'])
    try {
      await insertTask(f.raw, { id: 'T', state: 'running', attempts: 0, maxAttempts: 5 })
      await insertRun(f.raw, {
        id: 'prov-fail-run',
        taskId: 'T',
        attempt: 1,
        state: 'running',
        claimedBy: 'worker',
        claimExpiresAtMs: NOW + 60_000,
      })

      const world = new SimWorld(f.raw, 'fail-retry-replay')
      world.injectDuplicate({ label: 'fail' })
      let rejection: string | null = null
      world.actor('worker', async (db) => {
        await f
          .storeOver(db)
          .fail(Q, 'prov-fail-run', 'worker', '{"name":"Boom"}', { delaySeconds: 0 })
          .catch((error) => {
            if (!(error instanceof LeaseLostError)) rejection = String(error)
          })
      })
      await world.run()

      return {
        rejection,
        progress: await taskRunProgress(f.raw, 'T'),
        invariants: await engineInvariantViolations(f.raw),
      }
    } finally {
      f.close()
    }
  }

  async function claimedSuccessorRetryFailureReplay() {
    const f = await fixture(['successor-1'], ['fail-stamp'])
    try {
      await insertTask(f.raw, { id: 'T', state: 'running', attempts: 0, maxAttempts: 3 })
      await insertRun(f.raw, {
        id: 'claimed-fail-run',
        taskId: 'T',
        attempt: 1,
        state: 'running',
        claimedBy: 'worker',
        claimExpiresAtMs: NOW + 60_000,
      })
      const rec = recorder(f.raw)
      const store = f.storeOver(rec.db)
      await store.fail(Q, 'claimed-fail-run', 'worker', '{"name":"Boom"}', {
        delaySeconds: 0,
      })

      const [successor] = await query(
        f.raw,
        `SELECT run_id FROM runs WHERE task_id = 'T' AND attempt = 2`,
      )
      const successorId = String(successor?.run_id)
      const [claimed] = await store.claim(Q, 'next-worker', { leaseSeconds: 60, limit: 1 })
      let rejection: string | null = null
      await rec.replay('fail').catch((error) => {
        rejection = String(error)
      })

      const [task] = await query(
        f.raw,
        `SELECT state, failure_reason FROM tasks WHERE task_id = 'T'`,
      )
      const [after] = await query(f.raw, `SELECT state FROM runs WHERE run_id = ?`, [successorId])
      return {
        rejection,
        claimedSuccessor: claimed?.runId === successorId,
        task: { state: task?.state, failureReason: task?.failure_reason },
        successor: { state: after?.state },
        invariants: await engineInvariantViolations(f.raw),
      }
    } finally {
      f.close()
    }
  }

  it('retry failure replay preserves progress before and after the successor is claimed', async () => {
    expect(
      {
        immediate: await immediateRetryFailureReplay(),
        claimedSuccessor: await claimedSuccessorRetryFailureReplay(),
      },
      'mutation-verdict:behavior:successor-ownership',
    ).toEqual({
      immediate: {
        rejection: null,
        progress: {
          task: {
            state: 'pending',
            attempts: 1,
            infraRetries: 0,
            failureReason: null,
          },
          runs: [
            {
              runId: 'prov-fail-run',
              attempt: 1,
              state: 'failed',
              claimedBy: null,
              failureReason: '{"name":"Boom"}',
            },
            {
              runId: 'successor-1',
              attempt: 2,
              state: 'pending',
              claimedBy: null,
              failureReason: null,
            },
          ],
        },
        invariants: [],
      },
      claimedSuccessor: {
        rejection: null,
        claimedSuccessor: true,
        task: { state: 'running', failureReason: null },
        successor: { state: 'running' },
        invariants: [],
      },
    })
  })

  it('spawn refuses a newly minted task id that an orphan run already owns', async () => {
    const f = await fixture(['NEW-TASK', 'NEW-RUN'])
    try {
      await insertRun(f.raw, {
        id: 'ORPHAN',
        taskId: 'NEW-TASK',
        state: 'pending',
        availableAtMs: NOW,
      })

      const outcome = await f.store.spawn(Q, 'job', '{}').then(
        (value) => ({ kind: 'resolved' as const, value }),
        () => ({ kind: 'rejected' as const }),
      )
      const tasks = await query(f.raw, `SELECT task_id FROM tasks WHERE task_id = 'NEW-TASK'`)
      const runs = await query(
        f.raw,
        `SELECT run_id, task_id FROM runs WHERE task_id = 'NEW-TASK' ORDER BY run_id`,
      )

      expect(
        { outcome, tasks, runs },
        'mutation-verdict:behavior:spawn-rejects-orphan-owner',
      ).toEqual({
        outcome: { kind: 'rejected' },
        tasks: [],
        runs: [{ run_id: 'ORPHAN', task_id: 'NEW-TASK' }],
      })
    } finally {
      f.close()
    }
  })

  it('spawn cancellation construction owns the validated snapshot', async () => {
    const f = await fixture()
    const inheritedMaxDelay = Object.getOwnPropertyDescriptor(Object.prototype, 'maxDelaySeconds')
    try {
      const cancellation = { maxDelaySeconds: 30, maxDurationSeconds: 60 }
      Object.defineProperty(Object.prototype, 'maxDelaySeconds', {
        configurable: true,
        enumerable: false,
        set(_value: unknown) {},
      })

      let pending!: ReturnType<LibsqlSchedulerStore['spawn']>
      try {
        pending = f.store.spawn(Q, 'owned-cancellation', '{}', { cancellation })
      } finally {
        restoreOwnProperty(Object.prototype, 'maxDelaySeconds', inheritedMaxDelay)
      }
      const spawned = await pending
      const [task] = await query(
        f.raw,
        `SELECT cancellation, cancel_at_ms FROM tasks WHERE task_id = ?`,
        [spawned.taskId],
      )

      expect(task?.cancel_at_ms).toBe(NOW + 30_000)
      expect(
        task?.cancellation,
        'mutation-verdict:behavior:spawn-cancellation-owned-snapshot',
      ).toBe('{"maxDelaySeconds":30,"maxDurationSeconds":60}')
    } finally {
      restoreOwnProperty(Object.prototype, 'maxDelaySeconds', inheritedMaxDelay)
      f.close()
    }
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

  it('claim rejects a dialect-exact bigint that cannot cross the JavaScript port losslessly', async () => {
    const f = await fixture()
    try {
      await f.store.spawn(Q, 'job', '{}')
      const unsafe: SqlExecutor = {
        batch: async (label, statements, mode) =>
          (await f.raw.batch(label, statements, mode)).map((result) => ({
            ...result,
            rows: result.rows.map((row) =>
              label === 'claim' && row.attempt !== undefined
                ? { ...row, attempt: 9_007_199_254_740_993n }
                : row,
            ),
          })),
      }

      const outcome = await f
        .storeOver(unsafe)
        .claim(Q, 'worker', { leaseSeconds: 60, limit: 1 })
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          () => ({ kind: 'rejected' as const }),
        )

      expect(outcome).toEqual({ kind: 'rejected' })
    } finally {
      f.close()
    }
  })

  it('claim accepts the exact maximum run ordinal including the full infrastructure budget', async () => {
    const f = await fixture()
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}', { maxAttempts: MAX_COUNT })
      await f.raw.batch('at-run-ordinal-bound', [
        {
          sql: `UPDATE tasks SET attempts = ?, infra_retries = ? WHERE task_id = ?`,
          args: [MAX_COUNT - 1, INFRA_RETRY_CAP, spawned.taskId],
        },
        {
          sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
          args: [MAX_RUN_ORDINAL, spawned.runId],
        },
      ])

      const [claim] = await f.store.claim(Q, 'worker', { leaseSeconds: 60, limit: 1 })
      expect(claim).toMatchObject({
        attempt: MAX_RUN_ORDINAL,
        infraRetries: INFRA_RETRY_CAP,
        maxAttempts: MAX_COUNT,
      })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    } finally {
      f.close()
    }
  })

  it('claim rejects a hostile non-integer row value without coercing it for diagnostics', async () => {
    const f = await fixture()
    try {
      await f.store.spawn(Q, 'job', '{}')
      const hostile = {
        [Symbol.toPrimitive](): never {
          throw new Error('row coercion must not run')
        },
      }
      const malformed: SqlExecutor = {
        batch: async (label, statements, mode) =>
          (await f.raw.batch(label, statements, mode)).map((result) => ({
            ...result,
            rows: result.rows.map((row) =>
              label === 'claim' && row.attempt !== undefined
                ? { ...row, attempt: hostile as never }
                : row,
            ),
          })),
      }

      const error = await f
        .storeOver(malformed)
        .claim(Q, 'worker', { leaseSeconds: 60, limit: 1 })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        )
      expect(error).toBeInstanceOf(RangeError)
    } finally {
      f.close()
    }
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

  it('spawn receipt prefers the same-queue idempotency winner over a same-key foreign queue id collision', async () => {
    const f = await fixture(['A', 'NEW-RUN'])
    try {
      await insertTask(f.raw, {
        id: 'A',
        queue: 'other',
        state: 'pending',
        idempotencyKey: 'key',
      })
      await insertRun(f.raw, {
        id: 'rA',
        queue: 'other',
        taskId: 'A',
        state: 'pending',
      })
      await insertTask(f.raw, { id: 'Z', state: 'pending', idempotencyKey: 'key' })
      await insertRun(f.raw, { id: 'rZ', taskId: 'Z', state: 'pending' })

      const result = await f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'key' })

      expect(
        { created: result.created, taskId: result.taskId, runId: result.runId },
        'mutation-verdict:behavior:spawn-receipt-idempotency-priority-is-queue-scoped',
      ).toEqual({ created: false, taskId: 'Z', runId: 'rZ' })
    } finally {
      f.close()
    }
  })

  it('spawn rejects a task-id collision owned by a foreign queue without a same-queue idempotency winner', async () => {
    const f = await fixture(['A', 'NEW-RUN'])
    try {
      await insertTask(f.raw, {
        id: 'A',
        queue: 'other',
        state: 'pending',
        idempotencyKey: 'key',
      })
      await insertRun(f.raw, {
        id: 'rA',
        queue: 'other',
        taskId: 'A',
        state: 'pending',
      })

      const outcome = await f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'key' }).then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({
          kind: 'rejected' as const,
          type: error instanceof Error ? error.constructor : null,
          message: error instanceof Error ? error.message : null,
        }),
      )
      const tasks = await query(f.raw, `SELECT task_id, queue FROM tasks ORDER BY queue, task_id`)
      const runs = await query(
        f.raw,
        `SELECT run_id, queue, task_id FROM runs ORDER BY queue, run_id`,
      )

      expect(
        { outcome, tasks, runs },
        'mutation-verdict:behavior:spawn-receipt-task-id-collision-is-queue-scoped',
      ).toEqual({
        outcome: {
          kind: 'rejected',
          type: Error,
          message: 'spawn: the task insert lost but no existing task explains it',
        },
        tasks: [{ task_id: 'A', queue: 'other' }],
        runs: [{ run_id: 'rA', queue: 'other', task_id: 'A' }],
      })
    } finally {
      f.close()
    }
  })

  it('claim refuses a run whose task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      await exec(f.raw, `UPDATE tasks SET queue = 'other' WHERE task_id = ?`, [spawned.taskId])

      const claimed = await f.store.claim(Q, 'worker', { leaseSeconds: 60, limit: 1 })
      const [run] = await query(
        f.raw,
        `SELECT state, claimed_by, claim_gen FROM runs WHERE run_id = ?`,
        [spawned.runId],
      )

      expect(
        { claimed: claimed.length, run },
        'mutation-verdict:behavior:claim-requires-run-task-queue-ownership',
      ).toEqual({
        claimed: 0,
        run: { state: 'pending', claimed_by: null, claim_gen: 0 },
      })
    } finally {
      f.close()
    }
  })

  it('heartbeat refuses a run whose task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await moveTaskToOtherQueue(f, run.taskId)
      const before = await query(
        f.raw,
        `SELECT state, claimed_by, claim_expires_at_ms, heartbeat_at_ms
         FROM runs WHERE run_id = ?`,
        [run.runId],
      )

      const lease = await f.store.heartbeat(Q, run.runId, run.claimToken, 120)
      const after = await query(
        f.raw,
        `SELECT state, claimed_by, claim_expires_at_ms, heartbeat_at_ms
         FROM runs WHERE run_id = ?`,
        [run.runId],
      )

      expect(
        { lease, after },
        'mutation-verdict:behavior:heartbeat-requires-run-task-queue-ownership',
      ).toEqual({
        lease: { held: false, remainingMs: 0 },
        after: before,
      })
    } finally {
      f.close()
    }
  })

  it('expireLeaseNow refuses a run whose task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await moveTaskToOtherQueue(f, run.taskId)
      const before = await query(
        f.raw,
        `SELECT state, claimed_by, claim_expires_at_ms FROM runs WHERE run_id = ?`,
        [run.runId],
      )

      const expired = await f.store.expireLeaseNow(Q, run.runId, run.claimToken)
      const after = await query(
        f.raw,
        `SELECT state, claimed_by, claim_expires_at_ms FROM runs WHERE run_id = ?`,
        [run.runId],
      )

      expect(
        { expired, after },
        'mutation-verdict:behavior:expire-lease-requires-run-task-queue-ownership',
      ).toEqual({ expired: false, after: before })
    } finally {
      f.close()
    }
  })

  it('reschedule refuses a run whose task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await moveTaskToOtherQueue(f, run.taskId)
      const before = await query(
        f.raw,
        `SELECT r.state AS run_state, r.claimed_by, r.available_at_ms,
                t.state AS task_state
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
        [run.runId],
      )

      const outcome = await f.store
        .reschedule(Q, run.runId, run.claimToken, { inSeconds: 10 })
        .then(
          () => 'resolved' as const,
          (error: unknown) =>
            error instanceof LeaseLostError ? ('lease-lost' as const) : ('other-error' as const),
        )
      const after = await query(
        f.raw,
        `SELECT r.state AS run_state, r.claimed_by, r.available_at_ms,
                t.state AS task_state
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
        [run.runId],
      )

      expect(
        { outcome, after },
        'mutation-verdict:behavior:reschedule-requires-run-task-queue-ownership',
      ).toEqual({ outcome: 'lease-lost', after: before })
    } finally {
      f.close()
    }
  })

  it('suspendRun refuses a run whose task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await moveTaskToOtherQueue(f, run.taskId)
      const before = await query(
        f.raw,
        `SELECT r.state AS run_state, r.claimed_by, r.available_at_ms,
                t.state AS task_state
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
        [run.runId],
      )

      const outcome = await f.store
        .suspendRun(
          Q,
          run.runId,
          run.claimToken,
          { inSeconds: 10 },
          { key: 'queue-owner', stateJson: '{"ok":true}' },
        )
        .then(
          () => 'resolved' as const,
          (error: unknown) =>
            error instanceof LeaseLostError ? ('lease-lost' as const) : ('other-error' as const),
        )
      const after = await query(
        f.raw,
        `SELECT r.state AS run_state, r.claimed_by, r.available_at_ms,
                t.state AS task_state
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
        [run.runId],
      )
      const checkpoints = await query(
        f.raw,
        `SELECT checkpoint_name FROM checkpoints WHERE task_id = ?`,
        [run.taskId],
      )

      expect(
        { outcome, after, checkpoints },
        'mutation-verdict:behavior:suspend-requires-run-task-queue-ownership',
      ).toEqual({ outcome: 'lease-lost', after: before, checkpoints: [] })
    } finally {
      f.close()
    }
  })

  it('setCheckpoint refuses a run whose task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await moveTaskToOtherQueue(f, run.taskId)
      const before = await query(
        f.raw,
        `SELECT state, claimed_by, claim_expires_at_ms, heartbeat_at_ms,
                fence_stamp, fence_at_ms
         FROM runs WHERE run_id = ?`,
        [run.runId],
      )

      const outcome = await f.store
        .setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 'queue-owner', '{"ok":true}', 120)
        .then(
          () => 'resolved' as const,
          (error: unknown) =>
            error instanceof LeaseLostError ? ('lease-lost' as const) : ('other-error' as const),
        )
      const after = await query(
        f.raw,
        `SELECT state, claimed_by, claim_expires_at_ms, heartbeat_at_ms,
                fence_stamp, fence_at_ms
         FROM runs WHERE run_id = ?`,
        [run.runId],
      )
      const checkpoints = await query(
        f.raw,
        `SELECT checkpoint_name FROM checkpoints WHERE task_id = ?`,
        [run.taskId],
      )

      expect(
        { outcome, after, checkpoints },
        'mutation-verdict:behavior:set-checkpoint-requires-run-task-queue-ownership',
      ).toEqual({ outcome: 'lease-lost', after: before, checkpoints: [] })
    } finally {
      f.close()
    }
  })

  it('awaitEvent does not register or park when the task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await moveTaskToOtherQueue(f, run.taskId)
      const before = await query(
        f.raw,
        `SELECT r.state AS run_state, r.claimed_by, r.available_at_ms,
                r.wake_event, r.wake_step, t.state AS task_state
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
        [run.runId],
      )

      const outcome = await f.store
        .awaitEvent(Q, run.taskId, run.runId, run.claimToken, '$await:go', 'go', 30)
        .then(
          () => 'resolved' as const,
          (error: unknown) =>
            error instanceof LeaseLostError ? ('lease-lost' as const) : ('other-error' as const),
        )
      const after = await query(
        f.raw,
        `SELECT r.state AS run_state, r.claimed_by, r.available_at_ms,
                r.wake_event, r.wake_step, t.state AS task_state
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
        [run.runId],
      )
      const waits = await query(f.raw, `SELECT status FROM waits WHERE run_id = ?`, [run.runId])

      expect(
        { outcome, after, waits },
        'mutation-verdict:behavior:await-event-register-requires-run-task-queue-ownership',
      ).toEqual({ outcome: 'lease-lost', after: before, waits: [] })
    } finally {
      f.close()
    }
  })

  it('emitEvent leaves a parked run untouched when its task moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      const registration = await f.store.awaitEvent(
        Q,
        run.taskId,
        run.runId,
        run.claimToken,
        '$await:go',
        'go',
        null,
      )
      if (registration.emitted) throw new Error('expected a newly registered wait')
      await moveTaskToOtherQueue(f, run.taskId)
      const before = {
        owned: await query(
          f.raw,
          `SELECT r.state AS run_state, r.available_at_ms, r.wake_event, r.wake_step,
                  t.state AS task_state
           FROM runs r JOIN tasks t ON t.task_id = r.task_id
           WHERE r.run_id = ?`,
          [run.runId],
        ),
        waits: await query(
          f.raw,
          `SELECT status FROM waits WHERE run_id = ? AND step_name = '$await:go'`,
          [run.runId],
        ),
      }

      const outcome = await f.store.emitEvent(Q, 'go', '{"ok":true}').then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      const after = {
        owned: await query(
          f.raw,
          `SELECT r.state AS run_state, r.available_at_ms, r.wake_event, r.wake_step,
                  t.state AS task_state
           FROM runs r JOIN tasks t ON t.task_id = r.task_id
           WHERE r.run_id = ?`,
          [run.runId],
        ),
        waits: await query(
          f.raw,
          `SELECT status FROM waits WHERE run_id = ? AND step_name = '$await:go'`,
          [run.runId],
        ),
      }

      expect(
        { outcome, after },
        'mutation-verdict:behavior:emit-event-requires-run-task-queue-ownership',
      ).toEqual({ outcome: 'resolved', after: before })
    } finally {
      f.close()
    }
  })

  it('cancelTask refuses to cross into a run that moved to a different queue', async () => {
    const f = await fixture()
    try {
      const run = await activatedRun(f)
      await exec(f.raw, `UPDATE runs SET queue = 'other' WHERE run_id = ?`, [run.runId])
      const before = await query(
        f.raw,
        `SELECT t.state AS task_state, r.state AS run_state, r.claimed_by
         FROM tasks t JOIN runs r ON r.task_id = t.task_id
         WHERE t.task_id = ?`,
        [run.taskId],
      )

      const cancelled = await f.store.cancelTask(Q, run.taskId)
      const after = await query(
        f.raw,
        `SELECT t.state AS task_state, r.state AS run_state, r.claimed_by
         FROM tasks t JOIN runs r ON r.task_id = t.task_id
         WHERE t.task_id = ?`,
        [run.taskId],
      )

      expect(
        { cancelled, after },
        'regression:cancel-task-requires-run-task-queue-ownership',
      ).toEqual({ cancelled: false, after: before })
    } finally {
      f.close()
    }
  })

  it('generated cross-table relations cannot cross queue ownership', async () => {
    const f = await fixture()
    try {
      await insertTask(f.raw, { id: 'runs-to-tasks', state: 'pending', queue: 'other' })
      await insertRun(f.raw, {
        id: 'runs-to-tasks-source',
        taskId: 'runs-to-tasks',
        state: 'pending',
      })
      const runsToTasks = new FencedBatch('relation:runs-to-tasks', 'relation-seed', {
        now: NOW_MS,
      })
      runsToTasks.cas('source', 'runs', `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`, [
        'runs-to-tasks-source',
      ])
      runsToTasks.derived('target', {
        relation: 'runs-to-tasks',
        fence: 'source',
        set: { state: `'completed'` },
        rows: 'one',
      })
      await runsToTasks.run(f.raw)

      await insertTask(f.raw, { id: 'tasks-to-runs', state: 'pending' })
      await insertRun(f.raw, {
        id: 'tasks-to-runs-target',
        taskId: 'tasks-to-runs',
        state: 'pending',
        queue: 'other',
      })
      const tasksToRuns = new FencedBatch('relation:tasks-to-runs', 'relation-seed', {
        now: NOW_MS,
      })
      tasksToRuns.cas('source', 'tasks', `UPDATE tasks SET ${FENCE_SET} WHERE task_id = ?`, [
        'tasks-to-runs',
      ])
      tasksToRuns.derived('target', {
        relation: 'tasks-to-runs',
        fence: 'source',
        set: { state: `'failed'` },
        rows: 'one',
      })
      await tasksToRuns.run(f.raw)

      await insertTask(f.raw, { id: 'waits-to-runs', state: 'pending', queue: 'other' })
      await insertRun(f.raw, {
        id: 'waits-to-runs-target',
        taskId: 'waits-to-runs',
        state: 'pending',
        queue: 'other',
      })
      await exec(
        f.raw,
        `INSERT INTO waits
           (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
         VALUES (?, 'step', ?, ?, 'event', 'waiting', ?)`,
        ['waits-to-runs-target', Q, 'waits-to-runs', NOW],
      )
      const waitsToRuns = new FencedBatch('relation:waits-to-runs', 'relation-seed', {
        now: NOW_MS,
      })
      waitsToRuns.cas(
        'source',
        'waits',
        `UPDATE waits SET ${FENCE_SET} WHERE run_id = ? AND step_name = 'step'`,
        ['waits-to-runs-target'],
      )
      waitsToRuns.derived('target', {
        relation: 'waits-to-runs',
        fence: 'source',
        set: { state: `'failed'` },
        rows: 'one',
      })
      await waitsToRuns.run(f.raw)

      const observed = {
        runsToTasks: await query(f.raw, `SELECT state FROM tasks WHERE task_id = 'runs-to-tasks'`),
        tasksToRuns: await query(
          f.raw,
          `SELECT state FROM runs WHERE run_id = 'tasks-to-runs-target'`,
        ),
        waitsToRuns: await query(
          f.raw,
          `SELECT state FROM runs WHERE run_id = 'waits-to-runs-target'`,
        ),
      }
      expect(observed, 'mutation-verdict:construction:generated-relation-queue-ownership').toEqual({
        runsToTasks: [{ state: 'pending' }],
        tasksToRuns: [{ state: 'pending' }],
        waitsToRuns: [{ state: 'pending' }],
      })
    } finally {
      f.close()
    }
  })

  it('generated run cleanup follows authoritative run id through a corrupt wait queue', async () => {
    const f = await fixture()
    try {
      await insertTask(f.raw, { id: 'runs-to-waits', state: 'pending' })
      await insertRun(f.raw, {
        id: 'runs-to-waits-source',
        taskId: 'runs-to-waits',
        state: 'pending',
      })
      await exec(
        f.raw,
        `INSERT INTO waits
           (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
         VALUES (?, 'step', 'other', ?, 'event', 'waiting', ?)`,
        ['runs-to-waits-source', 'runs-to-waits', NOW],
      )
      const runsToWaits = new FencedBatch('relation:runs-to-waits', 'relation-seed', {
        now: NOW_MS,
      })
      runsToWaits.cas('source', 'runs', `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`, [
        'runs-to-waits-source',
      ])
      runsToWaits.derived('target', {
        relation: 'runs-to-waits',
        fence: 'source',
        rows: 'one',
      })
      await runsToWaits.run(f.raw)

      expect(
        await query(f.raw, `SELECT status FROM waits WHERE run_id = 'runs-to-waits-source'`),
        'regression:generated-runs-to-waits-authoritative-cleanup',
      ).toEqual([])
    } finally {
      f.close()
    }
  })

  it('a stored SQL NULL event payload is never delivered as a timeout', async () => {
    const f = await fixture()
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const [run] = await f.store.claim(Q, 'waiter', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected waiter claim')
      if (!(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen))) {
        throw new Error('expected waiter activation')
      }
      await f.store.awaitEvent(
        Q,
        spawned.taskId,
        run.runId,
        run.claimToken,
        '$await:go',
        'go',
        null,
      )
      await exec(
        f.raw,
        `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
         VALUES (?, 'go', NULL, ?)`,
        [Q, NOW],
      )

      const emitted = await f.store.emitEvent(Q, 'go', '{"real":true}').then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      const [claimed] = await f.store.claim(Q, 'next-worker', {
        leaseSeconds: 60,
        limit: 1,
      })
      const [storedRun] = await query(
        f.raw,
        `SELECT state, event_payload FROM runs WHERE run_id = ?`,
        [run.runId],
      )
      const waits = await query(
        f.raw,
        `SELECT status FROM waits WHERE run_id = ? AND step_name = '$await:go'`,
        [run.runId],
      )

      expect(
        { emitted, wake: claimed?.wake ?? null, run: storedRun, waits },
        'mutation-verdict:behavior:null-event-payload-never-becomes-timeout',
      ).toEqual({
        emitted: 'rejected',
        wake: null,
        run: { state: 'sleeping', event_payload: null },
        waits: [{ status: 'waiting' }],
      })
    } finally {
      f.close()
    }
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

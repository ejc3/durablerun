import { LeaseLostError } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '../src/index.js'

const Q = 'q'
const NOW = 1_000_000

/**
 * awaitEvent regressions found by the codex PR#11 review. Each constructs
 * the exact state with raw fixture SQL (the store's fences exist to make
 * these unreachable through the API) and drives the real awaitEvent.
 */
async function fixture(seed: string) {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  await admin.setFakeNowEpochMs(NOW)
  // Deterministic id source is irrelevant here; awaitEvent mints no ids.
  const store = new LibsqlSchedulerStore(raw, {
    uuidv7: () => `id-${seed}`,
    token: () => `tok-${seed}`,
  })
  return { raw, admin, store, close: () => raw.close() }
}

async function insertTask(
  raw: LibsqlExecutor,
  taskId: string,
  state: string,
  cancelAtMs: number | null,
) {
  await raw.batch(
    'setup',
    [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
                max_attempts, cancellation, state, enqueue_at_ms, first_started_at_ms,
                cancel_at_ms, created_at_ms)
              VALUES (?, ?, 'job', '{}', '{"kind":"none"}', 3,
                '{"maxDurationSeconds":1}', ?, ?, ?, ?, ?)`,
        args: [taskId, Q, state, NOW, NOW, cancelAtMs, NOW],
      },
    ],
    'write',
  )
}

async function insertRun(
  raw: LibsqlExecutor,
  runId: string,
  taskId: string,
  state: string,
  claimedBy: string | null,
) {
  await raw.batch(
    'setup',
    [
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by,
                claim_gen, activated_gen, claim_expires_at_ms, available_at_ms, created_at_ms)
              VALUES (?, ?, ?, 1, ?, ?, 1, 1, ?, ?, ?)`,
        args: [runId, Q, taskId, state, claimedBy, NOW + 60_000, NOW, NOW],
      },
    ],
    'write',
  )
}

async function countWaits(raw: LibsqlExecutor, runId: string): Promise<number> {
  const [rows] = await raw.batch(
    't',
    [{ sql: `SELECT COUNT(*) AS n FROM waits WHERE run_id = ?`, args: [runId] }],
    'read',
  )
  return Number(rows?.rows[0]?.n)
}

async function taskState(raw: LibsqlExecutor, taskId: string): Promise<string> {
  const [rows] = await raw.batch(
    't',
    [{ sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [taskId] }],
    'read',
  )
  return String(rows?.rows[0]?.state)
}

describe('awaitEvent review regressions', () => {
  it('leaves no orphan wait row when the park is refused (INSERT and park share one guard)', async () => {
    // Finding 2: the wait INSERT was guarded on state='running' only, but
    // the park on the stricter eligibleTask. A task past its maxDuration
    // cancel deadline with a still-valid lease: INSERT wrote a waiting row,
    // park matched nothing, and awaitEvent threw leaving the orphan behind.
    const f = await fixture('f2')
    await insertTask(f.raw, 't1', 'running', NOW - 1) // deadline already passed
    await insertRun(f.raw, 'r1', 't1', 'running', 'tok-live')
    await expect(
      f.store.awaitEvent(Q, 't1', 'r1', 'tok-live', '$await:go', 'go', null),
    ).rejects.toThrow(LeaseLostError)
    expect(await countWaits(f.raw, 'r1')).toBe(0)
    f.close()
  })

  it('a stale invocation cannot recreate a wait on a run left sleeping under the same step', async () => {
    // Codex re-review (round 3): a run left sleeping by a preserve reschedule
    // carries its wake_step but has no wait row. A stale awaitEvent with a
    // consumed token must NOT recreate the wait — the registration is fenced
    // on the live claim token, not the (non-unique) wake_step.
    const f = await fixture('stale')
    await insertTask(f.raw, 't1', 'sleeping', null)
    // Run sleeping under wake_step '$await:go', owned by a dead reschedule
    // stamp (NOT the caller's token below), timed-out (event_payload NULL).
    await f.raw.batch(
      'setup',
      [
        {
          sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by,
                  claim_gen, activated_gen, available_at_ms, wake_event, wake_step, created_at_ms)
                VALUES ('r1', ?, 't1', 1, 'sleeping', 'dead-stamp', 1, 1, ?, 'go', '$await:go', ?)`,
          args: [Q, NOW, NOW],
        },
      ],
      'write',
    )
    await expect(
      f.store.awaitEvent(Q, 't1', 'r1', 'consumed-token', '$await:go', 'go', 30),
    ).rejects.toThrow(LeaseLostError)
    expect(await countWaits(f.raw, 'r1')).toBe(0)
    f.close()
  })

  it('a losing stale invocation writes nothing — not even a same-value task mirror', async () => {
    // Codex re-review (round 4): the task-mirror fired on a pre-existing
    // sleeping run even when the park matched zero (a losing batch still
    // wrote, §3.4 rule 1). Observable here by constructing a run already
    // sleeping under a task still 'running': a stale awaitEvent whose park
    // fails must NOT flip the task to sleeping.
    const f = await fixture('losing-mirror')
    await insertTask(f.raw, 't1', 'running', null)
    await f.raw.batch(
      'setup',
      [
        {
          sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by,
                  claim_gen, activated_gen, available_at_ms, wake_event, wake_step, created_at_ms)
                VALUES ('r1', ?, 't1', 1, 'sleeping', 'dead-stamp', 1, 1, ?, 'go', '$await:go', ?)`,
          args: [Q, NOW, NOW],
        },
      ],
      'write',
    )
    await expect(
      f.store.awaitEvent(Q, 't1', 'r1', 'consumed-token', '$await:go', 'go', 30),
    ).rejects.toThrow(LeaseLostError)
    expect(await taskState(f.raw, 't1')).toBe('running') // mirror never fired
    f.close()
  })

  it('does not mirror the caller task to sleeping when the park parked a different run', async () => {
    // Finding 3: the task-mirror only checked that the given run is
    // sleeping, not that it belongs to the caller task. A mismatched call
    // (task A, run B where B is independently sleeping) flipped task A to
    // sleeping though A's run never parked.
    const f = await fixture('f3')
    await insertTask(f.raw, 'A', 'running', null)
    await insertRun(f.raw, 'runA', 'A', 'running', 'tok-A')
    await insertTask(f.raw, 'B', 'sleeping', null)
    await insertRun(f.raw, 'runB', 'B', 'sleeping', null)
    // task A's token, but run B's id — the park guards all fail.
    await expect(
      f.store.awaitEvent(Q, 'A', 'runB', 'tok-A', '$await:go', 'go', null),
    ).rejects.toThrow(LeaseLostError)
    expect(await taskState(f.raw, 'A')).toBe('running') // never mirrored to sleeping
    f.close()
  })
})

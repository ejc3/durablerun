import { FENCE_SET, FencedBatch } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { LibsqlExecutor } from '../src/index.js'
import { openTestDb } from '../src/testing.js'
import { NOW_MS } from '../src/time.js'

const NOW = 1_000_000

/**
 * `derived()` exists so that no caller writes the clause that decides which
 * rows a follow-on may touch — the primitive generates it, and the caller can
 * only ever shrink the result. These tests run the generated SQL against a
 * real dialect and ask the semantic question directly: did a row this batch
 * never stamped get written? Asserting on the generated TEXT would be the
 * same syntactic proxy that let this class through twice already.
 */
async function fixture() {
  const { raw, admin } = await openTestDb({ nowMs: NOW })
  return { raw, close: () => raw.close() }
}

async function insert(raw: LibsqlExecutor, taskId: string, runId: string, queue: string) {
  await raw.batch(
    'setup',
    [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
                max_attempts, cancellation, state, enqueue_at_ms, created_at_ms)
              VALUES (?, ?, 'job', '{}', '{"kind":"none"}', 3,
                '{"maxDurationSeconds":1}', 'running', ?, ?)`,
        args: [taskId, queue, NOW, NOW],
      },
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claim_gen,
                activated_gen, created_at_ms)
              VALUES (?, ?, ?, 1, 'running', 1, 1, ?)`,
        args: [runId, queue, taskId, NOW],
      },
    ],
    'write',
  )
}

async function stateOf(raw: LibsqlExecutor, taskId: string): Promise<string> {
  const [row] = (
    await raw.batch(
      'read',
      [{ sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [taskId] }],
      'read',
    )
  )[0]?.rows as { state: string }[]
  return row?.state ?? '(missing)'
}

/**
 * One stamped run in queue 'b', and a follow-on whose correlation is the
 * natural spelling of "either of these two queues". The disjunction is the
 * whole point: it lands in a boolean position, and unbracketed it binds as
 * `a OR (b AND fence)`.
 */
async function spread(raw: LibsqlExecutor): Promise<void> {
  const b = new FencedBatch('probe', 'seed', { now: NOW_MS })
  b.cas('win', 'runs', `UPDATE runs SET state = 'running', ${FENCE_SET} WHERE run_id = ?`, [
    'run-stamped',
  ])
  b.derived('spread', {
    target: 'tasks',
    stamp: 'tasks',
    key: 'task_id',
    from: 'runs',
    column: 'task_id',
    fence: 'win',
    where: `f.queue = ? OR f.queue = ?`,
    whereArgs: ['a', 'b'],
    set: `state = 'cancelled'`,
    rows: { many: 'one task per stamped run' },
  })
  await b.run(raw)
}

describe('a generated selection restricts to rows this batch stamped', () => {
  it('holds when the caller correlation is a disjunction', async () => {
    // `where` was interpolated into the fence subquery unparenthesised:
    //
    //   WHERE <corr> AND f.fence_stamp = ?
    //
    // AND binds tighter than OR, so a caller writing `a OR b` — the natural
    // spelling for "either of these two queues" — got
    //
    //   WHERE a OR (b AND f.fence_stamp = ?)
    //
    // and every row matching `a` entered the selection carrying no stamp at
    // all. That is the exact class the primitive was built to make
    // unwritable, reintroduced inside the thing that was supposed to prevent
    // it: `generated: true` also skips the OR scanner, on the reasoning that
    // generated SQL needs no scanning, which held right up until the
    // generator interpolated caller text into a boolean position.
    const f = await fixture()
    // Stamped: queue 'b'. Never stamped: queue 'a' — it can only be selected
    // through a disjunct that escaped the fence.
    await insert(f.raw, 'stamped', 'run-stamped', 'b')
    await insert(f.raw, 'untouched', 'run-untouched', 'a')

    await spread(f.raw)

    expect(await stateOf(f.raw, 'stamped')).toBe('cancelled')
    expect(await stateOf(f.raw, 'untouched')).toBe('running')
    f.close()
  })

  it('still writes provenance derived from the stamped source', async () => {
    // The provenance subquery interpolates the same correlation, so it has to
    // agree with the selection about which rows are in scope.
    const f = await fixture()
    await insert(f.raw, 'stamped', 'run-stamped', 'b')

    await spread(f.raw)

    const [row] = (
      await f.raw.batch(
        'read',
        [
          {
            sql: `SELECT t.fence_stamp AS s, t.fence_at_ms AS a, r.fence_at_ms AS ra
                  FROM tasks t JOIN runs r ON r.task_id = t.task_id
                  WHERE t.task_id = 'stamped'`,
            args: [],
          },
        ],
        'read',
      )
    )[0]?.rows as { s: string; a: number; ra: number }[]
    expect(row?.s).toBe('seed:spread')
    // One instant for the whole batch: the follow-on copies the CAS's, it
    // does not read the clock again (§3.4 rule 3).
    expect(row?.a).toBe(row?.ra)
    f.close()
  })
})
